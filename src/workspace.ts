import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type Readable } from 'node:stream';
import { StreamingRedactor } from './codex.js';
import { redact } from './trace.js';
import {
  buildSandboxInvocation,
  isWithin,
  terminateProcessTree,
  type SandboxOptions,
  type SandboxInvocation,
} from './sandbox.js';
import {
  MeshError,
  invariant,
  type Database,
  type EventSink,
  type Principal,
  type Sql,
} from './types.js';

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW = 16 * 1024;

export const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_operations (
  mission_id text NOT NULL,
  operation_id text NOT NULL,
  repo_id text NOT NULL,
  agent_id text NOT NULL,
  run_id text NOT NULL,
  generation integer NOT NULL,
  kind text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL,
  request jsonb NOT NULL,
  journal jsonb,
  result jsonb,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mission_id, operation_id)
);
CREATE INDEX IF NOT EXISTS workspace_operations_recovery ON workspace_operations(repo_id, state);
CREATE INDEX IF NOT EXISTS workspace_operations_run ON workspace_operations(run_id, state);
`;

export interface Dependencies {
  files?: Record<string, string | null>;
  decisions?: Record<string, number>;
}
export interface FileChange {
  path: string;
  expectedHash: string | null;
  content: string | null;
  mode?: number;
}
export interface PatchInput {
  operationId: string;
  claimId?: string;
  changes: FileChange[];
  dependencies?: Dependencies;
}
export interface ExecInput {
  operationId: string;
  claimId?: string;
  argv: string[];
  cwd?: string;
  mode: 'read' | 'mutate';
  timeoutMs?: number;
  network?: boolean;
  env?: Record<string, string>;
  dependencies?: Dependencies;
}
export type OperationState =
  'prepared' | 'running' | 'applied' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required';
export interface WorkspaceOperation {
  mission_id: string;
  operation_id: string;
  repo_id: string;
  agent_id: string;
  run_id: string;
  generation: number;
  kind: 'patch' | 'command';
  request_hash: string;
  state: OperationState;
  request: unknown;
  journal?: PatchJournal | CommandJournal | null;
  result?: unknown;
  error?: unknown;
  started_at?: string;
  updated_at?: string;
}
interface JournalChange {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  contentBase64: string | null;
  beforeMode: number | null;
  mode: number;
  temporaryPath: string;
}
interface PatchJournal {
  changes: JournalChange[];
  dependencies?: Dependencies;
}
interface ProcessIdentity {
  pid: number;
  startTicks: string;
  bootId: string;
}
interface CommandJournal {
  process?: ProcessIdentity;
  mode: 'read' | 'mutate';
  sourceBefore?: SourceManifest;
  outputDirectory: string;
}
export interface VerificationOptions {
  principal: Principal;
  operationId?: string;
  timeoutMs?: number;
  network?: boolean;
  env?: Record<string, string>;
}
export interface WorkspaceBarrier {
  manifest(): Promise<SourceManifest>;
  verify(argv: string[], options: VerificationOptions): Promise<CommandResult>;
}
export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: { path: string; bytes: number; tail: string };
  stderr: { path: string; bytes: number; tail: string };
  sourceBefore: string;
  sourceAfter: string;
  sourceChanged: boolean;
  cancelled: boolean;
  timedOut: boolean;
}
interface RunningCommand {
  principal: Principal;
  operationId: string;
  cancelled: boolean;
  child?: ChildProcess;
  done?: Promise<void>;
}
export interface WorkspaceOptions {
  repo: string;
  runtimeDir: string;
  db: Database;
  events: EventSink;
  authorize: (
    principal: Principal,
    paths: string[],
    operationId: string,
    claimId?: string,
    dependencies?: Dependencies,
  ) => Promise<void>;
  /** Injection seam for focused tests; production uses the enforced bubblewrap builder. */
  commandBuilder?: (options: SandboxOptions) => Promise<SandboxInvocation>;
  terminate?: typeof terminateProcessTree;
  /** Defaults to two expensive commands, separately from the CLI population. */
  maxCommands?: number;
  lockDirectory?: string;
}
export interface FileSnapshot {
  path: string;
  hash: string | null;
  content: string | null;
  mode: number | null;
}
export interface SourceManifest {
  hash: string;
  revision: number;
  basis: 'git-tracked-and-unignored';
  files: Array<{
    path: string;
    hash: string | null;
    mode: number | null;
    type: 'file' | 'symlink' | 'missing';
  }>;
}

export function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
function errorInfo(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof MeshError)
    return { code: error.code, message: error.message, details: error.details };
  return {
    code: 'operation_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}
function operationKey(principal: Principal, operationId: string): string {
  return `${principal.missionId}:${operationId}`;
}
function checkOperationId(operationId: string): void {
  invariant(
    typeof operationId === 'string' &&
      operationId.length > 0 &&
      operationId.length <= 256 &&
      !operationId.includes('\0'),
    'invalid_operation_id',
    'An operation ID must be a nonempty string of at most 256 characters.',
  );
}

class CommandCapacity {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((accept) => this.waiters.push(accept));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** One instance owns the physical checkout; all publication paths share its gate. */
export class Workspace {
  readonly repo: string;
  readonly runtimeDir: string;
  readonly repoId: string;
  private readonly options: WorkspaceOptions;
  private readonly lock: FileHandle;
  private readonly capacity: CommandCapacity;
  private readonly context = new AsyncLocalStorage<symbol>();
  private activeGate?: symbol;
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  private closed = false;
  private closing = false;
  private barriers = 0;
  private quarantine?: string;
  private readonly commands = new Map<string, RunningCommand>();
  private readonly revokedRuns = new Set<string>();
  private readonly yieldingRuns = new Set<string>();
  private activePatch?: { runId: string; done: Promise<void> };

  private constructor(
    options: WorkspaceOptions,
    repo: string,
    runtimeDir: string,
    repoId: string,
    lock: FileHandle,
  ) {
    this.options = options;
    this.repo = repo;
    this.runtimeDir = runtimeDir;
    this.repoId = repoId;
    this.lock = lock;
    this.capacity = new CommandCapacity(options.maxCommands ?? 2);
  }

  static async open(options: WorkspaceOptions): Promise<Workspace> {
    invariant(
      process.platform === 'linux' || process.platform === 'darwin',
      'unsupported_platform',
      'Workspace writer locking requires Linux or macOS.',
    );
    invariant(
      Number.isInteger(options.maxCommands ?? 2) && (options.maxCommands ?? 2) > 0,
      'invalid_capacity',
      'Command capacity must be a positive integer.',
    );
    const repo = await realpath(options.repo);
    const information = await lstat(repo);
    invariant(information.isDirectory(), 'invalid_repository', 'The checkout must be a directory.');
    await mkdir(options.runtimeDir, { recursive: true, mode: 0o700 });
    const runtimeDir = await realpath(options.runtimeDir);
    invariant(
      !isWithin(repo, runtimeDir) && !isWithin(runtimeDir, repo),
      'unsafe_runtime_directory',
      'Runtime files must live outside the checkout and cannot be its ancestor.',
    );
    const repoId = `${information.dev}:${information.ino}`;
    const lockDirectory =
      options.lockDirectory ?? join(tmpdir(), `mesh-exec-writers-${process.getuid?.() ?? 'user'}`);
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(lockDirectory);
    invariant(
      directoryInfo.isDirectory() &&
        !directoryInfo.isSymbolicLink() &&
        directoryInfo.uid === (process.getuid?.() ?? directoryInfo.uid) &&
        (directoryInfo.mode & 0o077) === 0,
      'unsafe_lock_directory',
      'The writer lock directory must be a private directory owned by the daemon user.',
    );
    const lockPath = join(lockDirectory, `${contentHash(repoId)}.lock`);
    const lock = await open(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await new Promise<void>((accept, reject) => {
        // flock(2) locks the inherited open file description on both platforms.
        // The parent retains that description until Workspace.close().
        const command = process.platform === 'darwin' ? 'python3' : 'flock';
        const args =
          process.platform === 'darwin'
            ? ['-c', 'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)']
            : ['--nonblock', '3'];
        const child = spawn(command, args, {
          stdio: ['ignore', 'ignore', 'pipe', lock.fd],
        });
        let message = '';
        child.stderr?.on('data', (chunk) => {
          message = (message + chunk.toString()).slice(-4096);
        });
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? accept()
            : reject(
                new MeshError(
                  'workspace_owned',
                  'Another daemon already owns this physical checkout.',
                  { code, message },
                ),
              ),
        );
      });
      const workspace = new Workspace(options, repo, runtimeDir, repoId, lock);
      await workspace.recover();
      return workspace;
    } catch (error) {
      await lock.close();
      throw error;
    }
  }

  private assertUsable(): void {
    invariant(
      !this.closed && !this.closing,
      'workspace_closed',
      'The workspace is closing or closed.',
    );
    if (this.quarantine) throw new MeshError('workspace_quarantined', this.quarantine);
  }

  private async gated<T>(body: () => Promise<T>): Promise<T> {
    if (this.context.getStore() && this.context.getStore() === this.activeGate) return body();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((accept) => {
      release = accept;
    });
    await previous;
    const token = Symbol('workspace-publication');
    this.activeGate = token;
    try {
      return await this.context.run(token, body);
    } finally {
      this.activeGate = undefined;
      release();
    }
  }

  async withBarrier<T>(body: (barrier: WorkspaceBarrier) => Promise<T>): Promise<T> {
    this.barriers++;
    try {
      // Read commands also finish their source-state accounting before final
      // verification takes the gate; otherwise they can occupy every command
      // slot while waiting for the verification holder's manifest lock.
      if (this.context.getStore() !== this.activeGate || this.activeGate === undefined) {
        await this.gated(async () => undefined); // Drain admissions already committing.
        await Promise.all([...this.commands.values()].map((command) => command.done));
      }
      return await this.gated(async () => {
        this.assertUsable();
        const token = this.activeGate;
        return body({
          manifest: () => this.manifest(),
          verify: async (argv, options) => {
            invariant(
              this.activeGate === token && this.context.getStore() === token,
              'barrier_expired',
              'Verification must execute inside its active barrier callback.',
            );
            const operationId = options.operationId ?? `verification-${randomUUID()}`;
            await this.admitCommand(
              options.principal,
              { ...options, operationId, argv, mode: 'read' },
              true,
            );
            const running = this.commands.get(operationKey(options.principal, operationId));
            if (running?.done) await running.done;
            const operation = await this.operation(options.principal, operationId);
            invariant(
              operation.state === 'succeeded' ||
                operation.state === 'failed' ||
                operation.state === 'cancelled',
              'verification_incomplete',
              'The verification command did not reach a terminal state.',
            );
            invariant(
              operation.result,
              'verification_failed',
              'Verification did not produce a command result.',
            );
            return operation.result as CommandResult;
          },
        });
      });
    } finally {
      this.barriers--;
    }
  }

  async canonicalPath(path: string, options: { allowRoot?: boolean } = {}): Promise<string> {
    return (await this.resolvePath(path, options.allowRoot)).path;
  }

  private normalize(path: string, allowRoot = false): string {
    invariant(
      typeof path === 'string' &&
        path.length > 0 &&
        !path.includes('\0') &&
        !path.includes('\\') &&
        !path.startsWith('/') &&
        !path.split('/').includes('..'),
      'invalid_path',
      'Paths must be repository-relative without traversal.',
    );
    const normalized = posix.normalize(path).replace(/^\.\//, '');
    invariant(
      (allowRoot || normalized !== '.') && !normalized.split('/').includes('.git'),
      'protected_path',
      'The repository root and Git metadata are not file mutation targets.',
    );
    return normalized;
  }

  private async resolvePath(
    path: string,
    allowRoot = false,
  ): Promise<{ path: string; absolute: string }> {
    const normalized = this.normalize(path, allowRoot);
    const absolute = resolve(this.repo, normalized);
    invariant(isWithin(this.repo, absolute), 'invalid_path', 'The path escapes the checkout.');
    let cursor = this.repo;
    for (const component of normalized === '.' ? [] : normalized.split('/')) {
      cursor = join(cursor, component);
      try {
        const information = await lstat(cursor);
        invariant(
          !information.isSymbolicLink(),
          'symlink_path',
          'Workspace operations do not follow symlinks.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    return { path: normalized, absolute };
  }

  private async snapshot(path: string): Promise<FileSnapshot> {
    const resolved = await this.resolvePath(path);
    try {
      const file = await open(resolved.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const information = await file.stat();
        invariant(information.isFile(), 'not_a_file', 'The requested path must be a regular file.');
        invariant(
          information.size <= MAX_PATCH_BYTES,
          'file_too_large',
          'Text workspace operations support files up to 8 MiB.',
        );
        const content = await file.readFile();
        return {
          path: resolved.path,
          hash: contentHash(content),
          content: content.toString('utf8'),
          mode: information.mode & 0o777,
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { path: resolved.path, hash: null, content: null, mode: null };
      throw error;
    }
  }

  async read(
    principal: Principal,
    paths: string[],
  ): Promise<{ revision: number; files: FileSnapshot[] }> {
    invariant(
      Array.isArray(paths) && paths.length <= 128,
      'invalid_read',
      'Read at most 128 files in one coherent batch.',
    );
    return this.gated(async () => {
      this.assertUsable();
      const files = await Promise.all(paths.map((path) => this.snapshot(path)));
      const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content ?? ''), 0);
      invariant(
        total <= MAX_PATCH_BYTES,
        'read_too_large',
        'This coherent read exceeds 8 MiB; request a smaller batch.',
      );
      await this.emit(principal, 'workspace.read', {
        revision: this.revision,
        files: files.map(({ content: _content, ...file }) => file),
      });
      return { revision: this.revision, files };
    });
  }

  private async emit(
    principal: Principal,
    kind: string,
    data: unknown,
    operationId?: string,
    tx?: Sql,
  ): Promise<void> {
    await this.options.events(
      { ...principal, kind, data, operationId, correlationId: operationId },
      tx,
    );
  }

  private async lookup(
    principal: Principal,
    operationId: string,
    sql: Sql = this.options.db,
  ): Promise<WorkspaceOperation | undefined> {
    const result = await sql.query<WorkspaceOperation>(
      'SELECT * FROM workspace_operations WHERE mission_id = $1 AND operation_id = $2 AND repo_id = $3',
      [principal.missionId, operationId, this.repoId],
    );
    return result.rows[0];
  }

  async operation(principal: Principal, operationId: string): Promise<WorkspaceOperation> {
    checkOperationId(operationId);
    const operation = await this.lookup(principal, operationId);
    invariant(
      operation,
      'operation_not_found',
      'No such operation exists in this mission and checkout.',
    );
    // Journal after-images are recovery material, not repeated status payloads.
    const { journal: _journal, request: _request, ...summary } = operation;
    return { ...summary, request: redact(operation.request) };
  }

  private async validateFiles(dependencies?: Dependencies): Promise<void> {
    for (const [path, expectedHash] of Object.entries(dependencies?.files ?? {})) {
      const file = await this.snapshot(path);
      if (file.hash !== expectedHash)
        throw new MeshError('stale_dependency', 'A declared input changed.', {
          path: file.path,
          expectedHash,
          actualHash: file.hash,
        });
    }
  }

  private async prepare(
    principal: Principal,
    operationId: string,
    kind: 'patch' | 'command',
    requestHash: string,
    request: unknown,
    journal?: PatchJournal | CommandJournal,
  ): Promise<{ operation: WorkspaceOperation; created: boolean }> {
    return this.options.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO workspace_operations
        (mission_id, operation_id, repo_id, agent_id, run_id, generation, kind, request_hash, state, request, journal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9::jsonb,$10::jsonb)
        ON CONFLICT (mission_id, operation_id) DO NOTHING RETURNING operation_id`,
        [
          principal.missionId,
          operationId,
          this.repoId,
          principal.agentId,
          principal.runId,
          principal.generation,
          kind,
          requestHash,
          JSON.stringify(request),
          journal ? JSON.stringify(journal) : null,
        ],
      );
      const operation = await this.lookup(principal, operationId, tx);
      invariant(
        operation && operation.request_hash === requestHash,
        'operation_id_conflict',
        'This operation ID was already used with different arguments.',
      );
      if (inserted.rows.length)
        await this.emit(
          principal,
          `workspace.${kind}.prepared`,
          { request: redact(request) },
          operationId,
          tx,
        );
      return { operation, created: inserted.rows.length > 0 };
    });
  }

  private async setState(
    principal: Principal,
    operationId: string,
    state: OperationState,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE workspace_operations SET state=$3, result=$4::jsonb, error=$5::jsonb,
        updated_at=clock_timestamp() WHERE mission_id=$1 AND operation_id=$2 AND repo_id=$6`,
        [
          principal.missionId,
          operationId,
          state,
          result === undefined ? null : JSON.stringify(result),
          error === undefined ? null : JSON.stringify(redact(error)),
          this.repoId,
        ],
      );
      await this.emit(
        principal,
        `workspace.operation.${state}`,
        { result, error: redact(error) },
        operationId,
        tx,
      );
    });
  }

  async patch(principal: Principal, input: PatchInput): Promise<WorkspaceOperation> {
    invariant(
      this.barriers === 0,
      'workspace_barrier',
      'Final verification has paused new publications.',
    );
    checkOperationId(input.operationId);
    invariant(
      Array.isArray(input.changes) && input.changes.length > 0 && input.changes.length <= 128,
      'invalid_patch',
      'A patch must contain between 1 and 128 file changes.',
    );
    const requestHash = contentHash(stableJson({ principal, kind: 'patch', input }));
    return this.gated(async () => {
      this.assertUsable();
      invariant(
        !this.runUnavailable(principal.runId),
        'run_revoked',
        'This run can no longer publish changes.',
      );
      let finish!: () => void;
      const done = new Promise<void>((accept) => {
        finish = accept;
      });
      this.activePatch = { runId: principal.runId, done };
      try {
        const existing = await this.lookup(principal, input.operationId);
        if (existing) {
          invariant(
            existing.request_hash === requestHash,
            'operation_id_conflict',
            'This operation ID was already used with different arguments.',
          );
          return this.operation(principal, input.operationId);
        }
        const changes: JournalChange[] = [];
        const seen = new Set<string>();
        let bytes = 0;
        for (const [index, change] of input.changes.entries()) {
          const path = this.normalize(change.path);
          invariant(!seen.has(path), 'duplicate_path', 'A patch can change a path only once.');
          seen.add(path);
          invariant(
            change.content === null || typeof change.content === 'string',
            'invalid_patch',
            'File content must be text or null for deletion.',
          );
          invariant(
            change.expectedHash === null || /^[a-f0-9]{64}$/.test(change.expectedHash),
            'invalid_hash',
            'Expected hashes must be SHA-256 hex strings or null.',
          );
          const before = await this.snapshot(path);
          if (before.hash !== change.expectedHash)
            throw new MeshError('stale_target', 'The write target changed.', {
              path,
              expectedHash: change.expectedHash,
              actualHash: before.hash,
            });
          const mode = change.mode ?? before.mode ?? 0o644;
          invariant(
            Number.isInteger(mode) && mode >= 0 && mode <= 0o777,
            'invalid_mode',
            'Only ordinary Unix permission bits are supported.',
          );
          const content = change.content === null ? null : Buffer.from(change.content);
          bytes += content?.length ?? 0;
          changes.push({
            path,
            beforeHash: before.hash,
            afterHash: content === null ? null : contentHash(content),
            contentBase64: content?.toString('base64') ?? null,
            beforeMode: before.mode,
            mode,
            temporaryPath: posix.join(
              posix.dirname(path),
              `.${posix.basename(path)}.mesh-${randomUUID()}-${index}.tmp`,
            ),
          });
        }
        invariant(
          bytes <= MAX_PATCH_BYTES,
          'patch_too_large',
          'A patch may publish at most 8 MiB.',
        );
        await this.validateFiles(input.dependencies);
        await this.options.authorize(
          principal,
          [...seen],
          input.operationId,
          input.claimId,
          input.dependencies,
        );
        const journal: PatchJournal = { changes, dependencies: input.dependencies };
        // The transaction commits before any filesystem write occurs.
        await this.prepare(
          principal,
          input.operationId,
          'patch',
          requestHash,
          { ...input, changes: input.changes.map(({ content: _content, ...change }) => change) },
          journal,
        );
        if (this.runUnavailable(principal.runId)) {
          await this.setState(principal, input.operationId, 'cancelled');
          return this.operation(principal, input.operationId);
        }
        try {
          for (const change of changes) await this.applyImage(change);
          this.revision++;
          await this.setState(principal, input.operationId, 'applied', {
            revision: this.revision,
            files: changes.map((change) => ({ path: change.path, hash: change.afterHash })),
          });
        } catch (error) {
          this.quarantine =
            'An interrupted publication requires journal reconciliation before further workspace activity.';
          await this.setState(
            principal,
            input.operationId,
            'recovery_required',
            undefined,
            errorInfo(error),
          ).catch(() => undefined);
          throw error;
        }
        return this.operation(principal, input.operationId);
      } finally {
        this.activePatch = undefined;
        finish();
      }
    });
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = dirname((await this.resolvePath(path)).absolute);
    let cursor = this.repo;
    for (const component of relative(this.repo, parent).split('/').filter(Boolean)) {
      const next = join(cursor, component);
      try {
        await mkdir(next, { mode: 0o755 });
        await this.syncDirectory(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const information = await lstat(next);
      invariant(
        information.isDirectory() && !information.isSymbolicLink(),
        'unsafe_parent',
        'A file parent is not a real directory.',
      );
      cursor = next;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async applyImage(change: JournalChange, recovering = false): Promise<void> {
    const target = await this.resolvePath(change.path);
    if (change.contentBase64 === null) {
      try {
        await unlink(target.absolute);
        await this.syncDirectory(dirname(target.absolute));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return;
    }
    await this.ensureParent(change.path);
    const temporary = await this.resolvePath(change.temporaryPath);
    if (recovering) {
      try {
        await unlink(temporary.absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const file = await open(
      temporary.absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      change.mode,
    );
    try {
      await file.writeFile(Buffer.from(change.contentBase64, 'base64'));
      await file.chmod(change.mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary.absolute, target.absolute);
    await this.syncDirectory(dirname(target.absolute));
  }

  private async recover(): Promise<void> {
    await this.gated(async () => {
      const pending = await this.options.db.query<WorkspaceOperation>(
        `SELECT * FROM workspace_operations WHERE repo_id=$1 AND state IN ('prepared','running','recovery_required') ORDER BY started_at, operation_id`,
        [this.repoId],
      );
      for (const operation of pending.rows) {
        const principal: Principal = {
          missionId: operation.mission_id,
          agentId: operation.agent_id,
          runId: operation.run_id,
          generation: operation.generation,
        };
        if (operation.kind === 'command') {
          const journal = operation.journal as CommandJournal | undefined;
          if (journal?.process) await this.stopRecordedProcess(journal.process);
          // A command may have external or partial source effects. Never rerun it automatically.
          await this.setState(principal, operation.operation_id, 'failed', undefined, {
            code: 'interrupted_command',
            message:
              'Daemon restart interrupted this command; inspect its logs and source effects before issuing another operation.',
          });
          continue;
        }
        const journal = operation.journal as PatchJournal | undefined;
        invariant(
          journal?.changes,
          'invalid_journal',
          'A prepared patch is missing its recovery images.',
        );
        const images = journal.changes;
        const current = await Promise.all(images.map((image) => this.snapshot(image.path)));
        const matchesAfter = (image: JournalChange, file: FileSnapshot) =>
          file.hash === image.afterHash && (image.afterHash === null || file.mode === image.mode);
        const matchesBefore = (image: JournalChange, file: FileSnapshot) =>
          file.hash === image.beforeHash &&
          (image.beforeMode === undefined || file.mode === image.beforeMode);
        const conflicts = images.filter(
          (image, index) =>
            !matchesBefore(image, current[index]) && !matchesAfter(image, current[index]),
        );
        if (conflicts.length) {
          this.quarantine =
            'Recovery found source changes outside the prepared operation; preserve them and resolve the recorded conflict.';
          await this.setState(principal, operation.operation_id, 'recovery_required', undefined, {
            code: 'recovery_conflict',
            paths: conflicts.map((image) => image.path),
          });
          throw new MeshError('recovery_conflict', this.quarantine, {
            operationId: operation.operation_id,
            paths: conflicts.map((image) => image.path),
          });
        }
        // Completing a known prepared patch is a recovery action, not a new run's authority.
        for (const [index, image] of images.entries()) {
          if (!matchesAfter(image, current[index])) await this.applyImage(image, true);
          else {
            const temporary = await this.resolvePath(image.temporaryPath);
            try {
              await unlink(temporary.absolute);
              await this.syncDirectory(dirname(temporary.absolute));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        }
        this.revision++;
        await this.setState(principal, operation.operation_id, 'applied', {
          recovered: true,
          revision: this.revision,
          files: images.map((image) => ({ path: image.path, hash: image.afterHash })),
        });
      }
    });
  }

  async manifest(): Promise<SourceManifest> {
    return this.gated(async () => {
      this.assertUsable();
      const { stdout } = await execFileAsync(
        'git',
        [
          '--no-optional-locks',
          '-C',
          this.repo,
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
      const paths = [...new Set(stdout.split('\0').filter(Boolean))].sort();
      const files: SourceManifest['files'] = [];
      for (const path of paths) {
        const normalized = this.normalize(path);
        const absolute = resolve(this.repo, normalized);
        try {
          const information = await lstat(absolute);
          if (information.isSymbolicLink()) {
            // Hash the link itself; never follow it out of the checkout.
            files.push({
              path: normalized,
              hash: contentHash(await readlink(absolute)),
              mode: information.mode & 0o777,
              type: 'symlink',
            });
          } else if (information.isFile()) {
            const safe = await this.resolvePath(normalized);
            const file = await open(safe.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const hash = createHash('sha256');
              for await (const chunk of file.createReadStream({ autoClose: false }))
                hash.update(chunk as Buffer);
              files.push({
                path: normalized,
                hash: hash.digest('hex'),
                mode: information.mode & 0o777,
                type: 'file',
              });
            } finally {
              await file.close();
            }
          } else {
            throw new MeshError(
              'unsupported_source_entry',
              'A source entry is not a regular file or symlink.',
              { path: normalized },
            );
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            files.push({ path: normalized, hash: null, mode: null, type: 'missing' });
          else throw error;
        }
      }
      return {
        hash: contentHash(stableJson(files)),
        revision: this.revision,
        basis: 'git-tracked-and-unignored',
        files,
      };
    });
  }

  async exec(principal: Principal, input: ExecInput): Promise<WorkspaceOperation> {
    return this.admitCommand(principal, input, false);
  }

  private async admitCommand(
    principal: Principal,
    input: ExecInput,
    verification: boolean,
  ): Promise<WorkspaceOperation> {
    this.assertUsable();
    invariant(
      verification || !this.runUnavailable(principal.runId),
      'run_revoked',
      'This run can no longer start commands.',
    );
    invariant(
      verification || this.barriers === 0,
      'workspace_barrier',
      'Final verification has paused new command admission.',
    );
    checkOperationId(input.operationId);
    invariant(
      Array.isArray(input.argv) &&
        input.argv.length > 0 &&
        input.argv.every((argument) => typeof argument === 'string' && !argument.includes('\0')),
      'invalid_command',
      'Commands require a nonempty argument array without NUL bytes.',
    );
    invariant(
      input.mode === 'read' || input.mode === 'mutate',
      'invalid_command_mode',
      'Command mode must be read or mutate.',
    );
    invariant(
      input.timeoutMs === undefined ||
        (Number.isInteger(input.timeoutMs) &&
          input.timeoutMs > 0 &&
          input.timeoutMs <= 24 * 60 * 60 * 1000),
      'invalid_timeout',
      'Command timeouts must be between 1 millisecond and 24 hours.',
    );
    const requestHash = contentHash(
      stableJson({ principal, kind: 'command', input, verification }),
    );
    const existing = await this.lookup(principal, input.operationId);
    if (existing) {
      invariant(
        existing.request_hash === requestHash,
        'operation_id_conflict',
        'This operation ID was already used with different arguments.',
      );
      return this.operation(principal, input.operationId);
    }
    const cwd = await this.resolvePath(input.cwd ?? '.', true);
    invariant(
      (await lstat(cwd.absolute)).isDirectory(),
      'invalid_cwd',
      'The command working directory must exist.',
    );
    if (!verification)
      await this.options.authorize(
        principal,
        input.mode === 'mutate' ? ['.'] : [],
        input.operationId,
        input.claimId,
        input.dependencies,
      );
    const outputDirectory = join(
      this.runtimeDir,
      'commands',
      contentHash(principal.missionId).slice(0, 16),
      contentHash(input.operationId),
      'outputs',
    );
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const environment = {
      ...(input.env ?? {}),
      MESH_OUTPUT_DIR: outputDirectory,
      TMPDIR: outputDirectory,
    };
    // Qualify the boundary before accepting the command, not after a model assumes it ran.
    const invocation = await (this.options.commandBuilder ?? buildSandboxInvocation)({
      repo: this.repo,
      argv: input.argv,
      cwd: cwd.absolute,
      writablePaths: [outputDirectory],
      network: input.network ?? false,
      sourceWritable: input.mode === 'mutate',
      env: environment,
      hiddenPaths: [this.runtimeDir],
    });
    return this.gated(async () => {
      this.assertUsable();
      invariant(
        verification || this.barriers === 0,
        'workspace_barrier',
        'Final verification has paused new command admission.',
      );
      invariant(
        verification || !this.runUnavailable(principal.runId),
        'run_revoked',
        'This run can no longer start commands.',
      );
      if (!verification)
        await this.options.authorize(
          principal,
          input.mode === 'mutate' ? ['.'] : [],
          input.operationId,
          input.claimId,
          input.dependencies,
        );
      const journal: CommandJournal = { mode: input.mode, outputDirectory };
      const secrets = Object.entries({ ...process.env, ...(input.env ?? {}) })
        .filter(
          ([key, value]) =>
            !!value &&
            /token|secret|password|passwd|api.?key|database_url|authorization/i.test(key),
        )
        .map(([, value]) => value!);
      const prepared = await this.prepare(
        principal,
        input.operationId,
        'command',
        requestHash,
        redact(
          {
            ...input,
            env: Object.fromEntries(Object.keys(input.env ?? {}).map((key) => [key, '[REDACTED]'])),
            verification,
            outputDirectory,
          },
          secrets,
        ),
        journal,
      );
      const key = operationKey(principal, input.operationId);
      // The INSERT decides idempotency even if a duplicate finishes qualification
      // after the original command has already left the in-memory registry.
      if (prepared.created) {
        const running: RunningCommand = {
          principal,
          operationId: input.operationId,
          cancelled: false,
        };
        this.commands.set(key, running);
        const execute = () => this.runCommand(running, input, invocation, journal, verification);
        // Only final verification inherits its caller's held gate. A normal
        // background command must obtain its own gate after admission returns.
        running.done = (verification ? execute() : this.context.exit(execute))
          .catch(async (error) => {
            await this.setState(
              principal,
              input.operationId,
              this.quarantine ? 'recovery_required' : 'failed',
              undefined,
              errorInfo(error),
            ).catch(() => undefined);
          })
          .finally(() => {
            this.commands.delete(key);
          });
      }
      return this.operation(principal, input.operationId);
    });
  }

  private async runCommand(
    running: RunningCommand,
    input: ExecInput,
    invocation: SandboxInvocation,
    journal: CommandJournal,
    verification: boolean,
  ): Promise<void> {
    const release = await this.capacity.acquire();
    // Source-mutating commands hold the publication gate for their complete lifetime.
    const execute = async () => {
      this.assertUsable();
      if (running.cancelled) {
        await this.setState(running.principal, input.operationId, 'cancelled');
        return;
      }
      if (!verification)
        await this.options.authorize(
          running.principal,
          input.mode === 'mutate' ? ['.'] : [],
          input.operationId,
          input.claimId,
          input.dependencies,
        );
      await this.validateFiles(input.dependencies);
      const before = await this.manifest();
      journal.sourceBefore = before;
      const secrets = Object.entries({ ...process.env, ...invocation.env })
        .filter(
          ([key, value]) =>
            !!value &&
            /token|secret|password|passwd|api.?key|database_url|authorization/i.test(key),
        )
        .map(([, value]) => value!);
      await this.emit(
        running.principal,
        'workspace.command.starting',
        {
          argv: redact(input.argv, secrets),
          cwd: input.cwd ?? '.',
          mode: input.mode,
          outputDirectory: journal.outputDirectory,
          sourceManifest: before.hash,
        },
        input.operationId,
      );
      if (running.cancelled || (!verification && this.runUnavailable(running.principal.runId))) {
        await this.setState(running.principal, input.operationId, 'cancelled');
        return;
      }
      const stdoutPath = join(dirname(journal.outputDirectory), 'stdout.log');
      const stderrPath = join(dirname(journal.outputDirectory), 'stderr.log');
      const [stdoutHandle, stderrHandle] = await Promise.all([
        open(stdoutPath, 'a', 0o600),
        open(stderrPath, 'a', 0o600),
      ]);
      if (running.cancelled || (!verification && this.runUnavailable(running.principal.runId))) {
        await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
        await this.setState(running.principal, input.operationId, 'cancelled');
        return;
      }
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: invocation.detached,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      running.child = child;
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (accept, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => accept({ code, signal }));
        },
      );
      // A rejection handler is installed before any asynchronous setup can yield.
      void ended.catch(() => undefined);
      // Attach pipe consumers before waiting for PostgreSQL. A short command can
      // exit during that wait, and Node otherwise drains unread child pipes.
      const stdoutCapture = this.capture(
        running.principal,
        input.operationId,
        'stdout',
        child.stdout!,
        stdoutPath,
        secrets,
        stdoutHandle,
      );
      const stderrCapture = this.capture(
        running.principal,
        input.operationId,
        'stderr',
        child.stderr!,
        stderrPath,
        secrets,
        stderrHandle,
      );
      void stdoutCapture.catch(() => undefined);
      void stderrCapture.catch(() => undefined);
      let timedOut = false;
      let timeoutFailure: unknown;
      const timeout = setTimeout(
        () => {
          timedOut = true;
          running.cancelled = true;
          void (this.options.terminate ?? terminateProcessTree)(child).catch((error) => {
            timeoutFailure = error;
            this.quarantine = 'A timed-out command namespace has not been confirmed stopped.';
          });
        },
        input.timeoutMs ?? 15 * 60 * 1000,
      );
      try {
        if (child.pid) journal.process = await this.processIdentity(child.pid);
        await this.options.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE workspace_operations SET state='running', journal=$3::jsonb, updated_at=clock_timestamp()
              WHERE mission_id=$1 AND operation_id=$2`,
            [running.principal.missionId, input.operationId, JSON.stringify(journal)],
          );
          await this.emit(
            running.principal,
            'workspace.command.running',
            { pid: child.pid, outputDirectory: journal.outputDirectory },
            input.operationId,
            tx,
          );
        });
        const captures = await Promise.all([stdoutCapture, stderrCapture, ended]);
        if (timeoutFailure) throw timeoutFailure;
        await (this.options.terminate ?? terminateProcessTree)(child);
        if (input.mode === 'mutate') this.revision++;
        const after = await this.manifest();
        const result: CommandResult = {
          exitCode: captures[2].code,
          signal: captures[2].signal,
          stdout: captures[0],
          stderr: captures[1],
          sourceBefore: before.hash,
          sourceAfter: after.hash,
          sourceChanged: before.hash !== after.hash || before.revision !== after.revision,
          cancelled: running.cancelled,
          timedOut,
        };
        await this.setState(
          running.principal,
          input.operationId,
          running.cancelled ? 'cancelled' : captures[2].code === 0 ? 'succeeded' : 'failed',
          result,
        );
      } catch (error) {
        try {
          await (this.options.terminate ?? terminateProcessTree)(child);
        } catch (termination) {
          this.quarantine =
            'A command namespace has not been confirmed stopped; its workspace resources remain unavailable.';
          throw termination;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        await Promise.allSettled([stdoutCapture, stderrCapture]);
      }
    };
    try {
      if (input.mode === 'mutate') await this.gated(execute);
      else await execute();
    } finally {
      release();
    }
  }

  private async capture(
    principal: Principal,
    operationId: string,
    channel: 'stdout' | 'stderr',
    source: Readable,
    path: string,
    secrets: string[],
    file: FileHandle,
  ): Promise<{ path: string; bytes: number; tail: string }> {
    const redactor = new StreamingRedactor(secrets);
    let bytes = 0;
    let tail = '';
    const write = async (text: string) => {
      if (!text) return;
      const offset = bytes;
      const buffer = Buffer.from(text);
      await file.writeFile(buffer);
      bytes += buffer.length;
      tail = (tail + text).slice(-MAX_PREVIEW);
      await this.emit(
        principal,
        'workspace.command.output',
        {
          channel,
          path,
          offset,
          bytes: buffer.length,
          preview: text.slice(-2048),
        },
        operationId,
      );
    };
    try {
      for await (const chunk of source) await write(redactor.write(chunk as Buffer));
      await write(redactor.end());
      await file.sync();
      return { path, bytes, tail };
    } finally {
      await file.close();
    }
  }

  private async processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
    try {
      const [stat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid, startTicks: fields[19], bootId: bootId.trim() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async stopRecordedProcess(recorded: ProcessIdentity): Promise<void> {
    const current = await this.processIdentity(recorded.pid);
    if (
      !current ||
      current.startTicks !== recorded.startTicks ||
      current.bootId !== recorded.bootId
    )
      return;
    // The namespace leader was started detached. Do not signal a recycled PID.
    try {
      process.kill(-recorded.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    for (let attempt = 0; attempt < 128; attempt++) {
      const remaining = await this.processIdentity(recorded.pid);
      if (
        !remaining ||
        remaining.startTicks !== recorded.startTicks ||
        remaining.bootId !== recorded.bootId
      )
        return;
      await new Promise((accept) => setTimeout(accept, 16));
    }
    throw new MeshError(
      'termination_unconfirmed',
      'A previous command namespace still exists; recovery is blocked.',
      { pid: recorded.pid },
    );
  }

  async cancel(principal: Principal, operationId: string): Promise<WorkspaceOperation> {
    checkOperationId(operationId);
    const operation = await this.lookup(principal, operationId);
    invariant(operation, 'operation_not_found', 'No such operation exists in this mission.');
    invariant(
      operation.run_id === principal.runId && operation.generation === principal.generation,
      'operation_owner_mismatch',
      'Only the operation owner can cancel it through an agent tool.',
    );
    const running = this.commands.get(operationKey(principal, operationId));
    if (running) {
      running.cancelled = true;
      await this.emit(principal, 'workspace.command.cancel_requested', {}, operationId);
      if (running.child) {
        try {
          await (this.options.terminate ?? terminateProcessTree)(running.child);
        } catch (error) {
          this.quarantine = 'Cancellation could not confirm namespace termination.';
          throw error;
        }
        if (running.done) await running.done;
      } else {
        await this.setState(principal, operationId, 'cancelled');
      }
    }
    return this.operation(principal, operationId);
  }

  private runUnavailable(runId: string): boolean {
    return this.revokedRuns.has(runId) || this.yieldingRuns.has(runId);
  }

  async yieldRun<T>(runId: string, releaseClaims: () => Promise<T>): Promise<T> {
    invariant(!this.runUnavailable(runId), 'run_revoked', 'Run is revoked or already yielding.');
    this.yieldingRuns.add(runId);
    try {
      await this.drainRun(runId);
      return await releaseClaims();
    } finally {
      // A concurrent supervisor cancellation remains in revokedRuns.
      this.yieldingRuns.delete(runId);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    this.revokedRuns.add(runId);
    await this.drainRun(runId);
  }

  private async drainRun(runId: string): Promise<void> {
    const patch = this.activePatch?.runId === runId ? this.activePatch.done : undefined;
    const commands = [...this.commands.values()].filter(
      (command) => command.principal.runId === runId,
    );
    for (const command of commands) command.cancelled = true;
    for (const command of commands) {
      if (command.child) {
        try {
          await (this.options.terminate ?? terminateProcessTree)(command.child);
        } catch (error) {
          this.quarantine = 'Run cancellation could not confirm namespace termination.';
          throw error;
        }
      }
    }
    await Promise.all([
      ...commands.filter((command) => command.child).map((command) => command.done),
      patch,
    ]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    const runIds = new Set([...this.commands.values()].map((command) => command.principal.runId));
    for (const runId of runIds) await this.cancelRun(runId);
    await this.gated(async () => {
      this.closed = true;
      await this.lock.close();
    });
  }
}
