import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildCodexInvocation,
  CODEX_RESULT_SCHEMA,
  CodexEventTracker,
  codexEnvironment,
  environmentSecrets,
  parseCodexRunResult,
  prepareCodexRunFiles,
  preflightCodex,
  StreamingRedactor,
  type CodexRunResult,
  type CodexQualification,
  type CodexPreflightOptions,
  type CodexEventCorrelation,
} from './codex.js';
import { buildSandboxInvocation, terminateProcessTree } from './sandbox.js';
import { redact } from './trace.js';
import type { EventSink, MissionState, Principal, TraceInput } from './types.js';

export interface SupervisorIdentity {
  missionId: string;
  supervisorId: string;
  epoch: number;
}
export interface MissionObservation {
  state: MissionState;
  workRevision: string;
}
export interface RunAllocation {
  principal: Principal;
  token: string;
}
export interface RunEnd {
  status: 'exited' | 'failed' | 'aborted' | 'timed-out';
  exitCode: number | null;
  signal: string | null;
  result: CodexRunResult | null;
  error?: string;
  reaped: boolean;
}

export interface CaptureFailure {
  stage: string;
  code: string;
  message: string;
}

/** Hashes and line counts describe the retained redacted bytes. */
export interface ArtifactCapture {
  path: string;
  bytes: number;
  /** Physical newline-delimited lines, including a nonempty unterminated tail. */
  lines: number;
  sha256: string | null;
  synced: boolean;
  failures: CaptureFailure[];
}

export interface StreamCapture extends ArtifactCapture {
  sourceBytes: number;
  eof: boolean;
  indexedEvents: number;
  indexComplete: boolean;
}

export interface ResultCapture extends ArtifactCapture {
  status: 'valid' | 'invalid' | 'missing';
}

export interface RunCaptureManifest extends Principal {
  schemaVersion: 1;
  finalizedAt: string;
  status: 'complete' | 'incomplete';
  prompt: ArtifactCapture;
  schema: ArtifactCapture;
  stdout: StreamCapture;
  stderr: StreamCapture;
  result: ResultCapture;
  failures: CaptureFailure[];
  /** Completion means the OS pipe write completed, not model incorporation. */
  stdin: { bytes: number; completed: boolean; failures: CaptureFailure[] };
}

/** The store fences generations. The runner never assigns roadmap work. */
export interface RunnerStore {
  acquireSupervisor(input: {
    missionId: string;
    supervisorId: string;
    pid: number;
    hostname: string;
    leaseMs: number;
  }): Promise<{ epoch: number }>;
  renewSupervisor(input: SupervisorIdentity & { leaseMs: number }): Promise<void>;
  releaseSupervisor(input: SupervisorIdentity): Promise<void>;
  observe(missionId: string): Promise<MissionObservation>;
  waitForRevision(
    missionId: string,
    afterRevision: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<MissionObservation>;
  allocateRun(input: SupervisorIdentity & { agentId: string }): Promise<RunAllocation>;
  setPid(principal: Principal, pid: number, logDir?: string): Promise<void>;
  heartbeat(principal: Principal): Promise<void>;
  endRun(principal: Principal, end: RunEnd): Promise<void>;
  stopMission(
    missionId: string,
    state: 'stopped' | 'resource-limit' | 'stalled',
    reason: string,
  ): Promise<void>;
}

export interface SandboxSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: true;
}
export type SandboxBuilder = (input: {
  repo: string;
  argv: string[];
  writablePaths: string[];
  cwd?: string;
  network?: boolean;
  sourceWritable?: boolean;
  env?: Record<string, string>;
  hiddenPaths?: string[];
}) => Promise<SandboxSpec>;
export type WorkerSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface RunMeshOptions {
  missionId: string;
  repository: string;
  roadmapPath: string;
  mcpUrl: string;
  logRoot: string;
  store: RunnerStore;
  events: EventSink;
  /** Cancel and reap daemon-owned commands before the run generation is released. */
  stopOperations: (principal: Principal) => Promise<void>;
  concurrency?: number;
  maxRuns?: number;
  maxElapsedMs?: number;
  runTimeoutMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  idlePollMs?: number;
  restartBackoffMs?: number;
  codexBinary?: string;
  model?: string;
  environment?: NodeJS.ProcessEnv;
  /** These paths must be outside the shared repository. */
  runtimeWritablePaths?: string[];
  hiddenPaths?: string[];
  signal?: AbortSignal;
  /** Injection point for a qualified process adapter in tests. */
  preflight?: (input: CodexPreflightOptions) => Promise<CodexQualification>;
  sandbox?: SandboxBuilder;
  spawn?: WorkerSpawner;
  terminate?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
}

export interface RunnerSummary {
  missionId: string;
  supervisorId: string;
  epoch: number;
  runsStarted: number;
  runsFinished: number;
  state: MissionState;
}

function validLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function errorText(error: unknown, secrets: string[] = []): string {
  return String(redact(error instanceof Error ? error.message : String(error), secrets));
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      path !== '..' &&
      !isAbsolute(path))
  );
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new Error('Invalid identity for a run log directory');
  return value;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function artifactCapture(path: string): ArtifactCapture {
  return { path, bytes: 0, lines: 0, sha256: null, synced: false, failures: [] };
}

function streamCapture(path: string): StreamCapture {
  return {
    ...artifactCapture(path),
    sourceBytes: 0,
    eof: false,
    indexedEvents: 0,
    indexComplete: false,
  };
}

function captureFailure(stage: string, error: unknown, secrets: string[]): CaptureFailure {
  const nativeCode =
    error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    stage,
    code:
      typeof nativeCode === 'string' && /^[A-Z0-9_]+$/u.test(nativeCode)
        ? nativeCode
        : `CAPTURE_${stage.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`,
    message: errorText(error, secrets),
  };
}

/** Count and hash each successful write, including partial filesystem writes. */
class ArtifactWriter {
  private readonly hash = createHash('sha256');
  private newlines = 0;
  private lastByte?: number;

  constructor(
    private readonly file: FileHandle,
    private readonly metadata: ArtifactCapture,
  ) {}

  async write(text: string): Promise<void> {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await this.file.write(bytes, offset, bytes.length - offset);
      if (bytesWritten === 0)
        throw Object.assign(new Error('Output file accepted a zero-byte write'), {
          code: 'CAPTURE_SHORT_WRITE',
        });
      const written = bytes.subarray(offset, offset + bytesWritten);
      this.hash.update(written);
      for (const byte of written) if (byte === 10) this.newlines++;
      this.lastByte = written.at(-1);
      this.metadata.bytes += bytesWritten;
      this.metadata.lines = this.newlines + (this.lastByte === 10 ? 0 : 1);
      offset += bytesWritten;
    }
  }

  async finish(fail: (stage: string, error: unknown) => void): Promise<void> {
    try {
      await this.file.sync();
      this.metadata.synced = true;
    } catch (error) {
      fail('sync', error);
    }
    try {
      await this.file.close();
    } catch (error) {
      fail('close', error);
    }
    this.metadata.sha256 = this.hash.digest('hex');
  }
}

function redactedText(text: string, secrets: string[]): string {
  const redactor = new StreamingRedactor(secrets);
  return redactor.write(text) + redactor.end();
}

async function persistArtifact(
  metadata: ArtifactCapture,
  text: string,
  secrets: string[],
): Promise<void> {
  let failure: unknown;
  const fail = (stage: string, error: unknown): void => {
    metadata.failures.push(captureFailure(stage, error, secrets));
    failure ??= error;
  };
  let file: FileHandle;
  try {
    file = await open(metadata.path, 'ax', 0o600);
  } catch (error) {
    fail('open', error);
    throw error;
  }
  const writer = new ArtifactWriter(file, metadata);
  try {
    await writer.write(text);
  } catch (error) {
    fail('write', error);
  }
  await writer.finish(fail);
  if (failure) throw failure;
}

function traceCorrelation(codex: CodexEventCorrelation): Partial<TraceInput> {
  return {
    ...(codex.threadId ? { correlationId: codex.threadId } : {}),
    ...(codex.itemId ? { spanId: codex.itemId } : codex.turnId ? { spanId: codex.turnId } : {}),
    ...(codex.itemId && codex.turnId ? { parentSpanId: codex.turnId } : {}),
  };
}

/** Index lines with bounded memory; every byte remains in the complete log file. */
class LineIndex {
  private pending = '';
  private offset = 0;
  private oversized = false;
  constructor(
    private readonly consume: (
      line: string | null,
      offset: number,
      length: number,
    ) => Promise<void>,
  ) {}

  async write(text: string): Promise<void> {
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      const piece = newline < 0 ? text.slice(start) : text.slice(start, newline);
      if (!this.oversized) {
        this.pending += piece;
        if (this.pending.length > 1024 * 1024) {
          this.oversized = true;
          await this.consume(null, this.offset, Buffer.byteLength(this.pending));
          this.offset += Buffer.byteLength(this.pending);
          this.pending = '';
        }
      } else {
        const length = Buffer.byteLength(piece);
        if (length) await this.consume(null, this.offset, length);
        this.offset += length;
      }
      if (newline < 0) return;
      if (!this.oversized) {
        const length = Buffer.byteLength(this.pending) + 1;
        await this.consume(this.pending, this.offset, length);
        this.offset += length;
      } else {
        await this.consume(null, this.offset, 1);
        this.offset += 1;
      }
      this.pending = '';
      this.oversized = false;
      start = newline + 1;
    }
  }

  async end(): Promise<void> {
    if (this.pending) {
      await this.consume(this.pending, this.offset, Buffer.byteLength(this.pending));
      this.pending = '';
    }
  }
}

async function captureOutput(
  stream: Readable,
  channel: 'stdout' | 'stderr',
  metadata: StreamCapture,
  file: FileHandle,
  principal: Principal,
  secrets: string[],
  tracker: CodexEventTracker,
  emit: (input: TraceInput) => Promise<unknown>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  const { path } = metadata;
  const writer = new ArtifactWriter(file, metadata);
  const redactor = new StreamingRedactor(secrets);
  let failure: unknown;
  let writable = true;
  let indexable = true;
  const fail = (stage: string, error: unknown): void => {
    metadata.failures.push(captureFailure(stage, error, secrets));
    failure ??= error;
    onFailure(error);
  };
  const emitIndexed = async (input: TraceInput): Promise<unknown> => {
    const result = await emit(input);
    metadata.indexedEvents++;
    return result;
  };
  const index = new LineIndex(async (line, offset, length) => {
    const codex = tracker.current();
    const common = {
      ...principal,
      traceId: principal.runId,
      data: { channel, path, offset, length, codex },
    };
    if (line === null) {
      await emitIndexed({ ...common, ...traceCorrelation(codex), kind: 'codex.output.segment' });
      return;
    }
    if (channel === 'stdout' && line.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        // Non-JSON output is retained and indexed below.
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const event = parsed as Record<string, unknown>;
        const type =
          typeof event.type === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/u.test(event.type)
            ? event.type
            : 'unknown';
        const item =
          event.item && typeof event.item === 'object' && !Array.isArray(event.item)
            ? (event.item as Record<string, unknown>)
            : null;
        const observed = tracker.observe(event);
        const arguments_ =
          item?.server === 'mesh' && item.arguments && typeof item.arguments === 'object'
            ? (item.arguments as Record<string, unknown>)
            : undefined;
        const handles = Object.fromEntries(
          ['messageId', 'taskId', 'operationId']
            .filter((key) => typeof arguments_?.[key] === 'string')
            .map((key) => [key, arguments_![key]]),
        );
        await emitIndexed({
          ...common,
          kind: `codex.${type}`,
          ...traceCorrelation(observed),
          ...handles,
          data: { channel, path, offset, length, codex: observed, event: redact(event, secrets) },
        });
        // Managed policy remains authoritative. Detect unexpected remote tools
        // if the installed CLI exposes them despite the isolated configuration.
        if (
          item?.type === 'mcp_tool_call' &&
          typeof item.server === 'string' &&
          item.server !== 'mesh'
        ) {
          throw Object.assign(new Error(`Unexpected MCP server in worker output: ${item.server}`), {
            code: 'UNEXPECTED_MCP_SERVER',
          });
        }
        return;
      }
    }
    await emitIndexed({
      ...common,
      ...traceCorrelation(codex),
      kind: `codex.${channel}`,
      data: { channel, path, offset, length, codex, text: line },
    });
  });
  // Index errors stop admission promptly, while the pipe continues draining to
  // its durable file. The manifest distinguishes capture from index integrity.
  const indexed = async (body: () => Promise<void>): Promise<void> => {
    if (!indexable) return;
    try {
      await body();
    } catch (error) {
      indexable = false;
      fail('index', error);
    }
  };
  async function append(text: string): Promise<void> {
    if (!text || !writable) return;
    try {
      await writer.write(text);
    } catch (error) {
      writable = false;
      indexable = false;
      fail('write', error);
      return;
    }
    await indexed(() => index.write(text));
  }
  try {
    for await (const chunk of stream) {
      const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      metadata.sourceBytes += source.length;
      await append(redactor.write(source));
    }
    metadata.eof = true;
  } catch (error) {
    fail('read', error);
  } finally {
    // Even an interrupted read can have an already-received redactor tail.
    await append(redactor.end());
    await indexed(() => index.end());
    metadata.indexComplete = indexable && writable && metadata.eof;
    await writer.finish(fail);
  }
  if (failure) throw failure;
}

async function captureRunResult(
  path: string,
  metadata: ResultCapture,
  secrets: string[],
): Promise<{ result: CodexRunResult | null; text?: string }> {
  const fail = (stage: string, error: unknown): void => {
    metadata.failures.push(captureFailure(stage, error, secrets));
  };
  let input: FileHandle;
  try {
    input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    metadata.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
    fail('open', error);
    return { result: null };
  }
  metadata.status = 'invalid';
  const temporary = `${metadata.path}.redacted-${randomUUID()}`;
  const redactor = new StreamingRedactor(secrets);
  const pieces: string[] = [];
  let replaced = false;
  let writer: ArtifactWriter | undefined;
  try {
    if (!(await input.stat()).isFile())
      throw Object.assign(new Error('Codex handoff must be a regular file'), {
        code: 'RESULT_NOT_REGULAR',
      });
    const output = await open(temporary, 'ax', 0o600);
    writer = new ArtifactWriter(output, metadata);
    const append = async (text: string): Promise<void> => {
      await writer!.write(text);
      if (metadata.bytes <= 8 * 1024 * 1024) pieces.push(text);
    };
    try {
      for await (const chunk of input.createReadStream({ autoClose: false }))
        await append(redactor.write(chunk as Buffer));
      await append(redactor.end());
    } catch (error) {
      fail('archive', error);
    } finally {
      await writer.finish(fail);
    }
    await rename(temporary, metadata.path);
    replaced = true;
    if (!metadata.failures.length) await unlink(path);
  } catch (error) {
    fail('archive', error);
  } finally {
    try {
      await input.close();
    } catch (error) {
      fail('close', error);
    }
    if (!replaced) {
      await unlink(temporary).catch(() => undefined);
      metadata.sha256 = null;
      metadata.synced = false;
    }
  }
  if (metadata.failures.length) return { result: null };
  if (metadata.bytes > 8 * 1024 * 1024) {
    fail(
      'validation',
      Object.assign(
        new Error(
          'Codex handoff exceeds the structured result budget; the complete redacted file is retained',
        ),
        { code: 'RESULT_TOO_LARGE' },
      ),
    );
    return { result: null };
  }
  const text = pieces.join('');
  try {
    const parsed = parseCodexRunResult(JSON.parse(text));
    if (['idle', 'blocked'].includes(parsed.outcome) && parsed.work_revision === null) {
      throw Object.assign(new Error('A parked run must report work_revision from mesh_yield'), {
        code: 'RESULT_MISSING_WORK_REVISION',
      });
    }
    metadata.status = 'valid';
    return { result: parsed, text };
  } catch (error) {
    fail(
      'validation',
      error instanceof SyntaxError ? Object.assign(error, { code: 'RESULT_INVALID_JSON' }) : error,
    );
    return { result: null, text };
  }
}

/** Maintain N peers; useful work is discovered by those peers, never dispatched here. */
export async function runMesh(options: RunMeshOptions): Promise<RunnerSummary> {
  const concurrency = validLimit(options.concurrency ?? 10, 'concurrency');
  const maxRuns = validLimit(options.maxRuns ?? 1024, 'maxRuns');
  const maxElapsedMs = validLimit(options.maxElapsedMs ?? 8 * 60 * 60 * 1000, 'maxElapsedMs');
  const runTimeoutMs = validLimit(options.runTimeoutMs ?? 32 * 60 * 1000, 'runTimeoutMs');
  const heartbeatMs = validLimit(options.heartbeatMs ?? 8000, 'heartbeatMs');
  const leaseMs = validLimit(options.leaseMs ?? Math.max(32000, heartbeatMs * 4), 'leaseMs');
  if (leaseMs < heartbeatMs * 2)
    throw new Error('leaseMs must allow at least two heartbeat intervals');
  const idlePollMs = validLimit(options.idlePollMs ?? 8000, 'idlePollMs');
  const backoffMs = validLimit(options.restartBackoffMs ?? 1000, 'restartBackoffMs');
  safeSegment(options.missionId);
  const repository = await realpath(options.repository);
  await mkdir(options.logRoot, { recursive: true, mode: 0o700 });
  const logRoot = await realpath(options.logRoot);
  if (inside(repository, logRoot))
    throw new Error('Run logs must be outside the shared read-only repository');
  const environment = options.environment ?? codexEnvironment(process.env);
  const globalSecrets = environmentSecrets(environment);
  const qualification = await (options.preflight ?? preflightCodex)({
    codexBinary: options.codexBinary,
    repository,
    environment,
    signal: options.signal,
  });
  const supervisorId = randomUUID();
  const controller = new AbortController();
  const active = new Map<string, Principal>();
  let abortState: 'stopped' | 'resource-limit' | 'stalled' = 'stopped';
  let abortReason = 'Runner stopped';
  let fatal: unknown;
  let runsStarted = 0;
  let runsFinished = 0;
  const abort = (state: typeof abortState, reason: string): void => {
    if (controller.signal.aborted) return;
    abortState = state;
    abortReason = reason;
    controller.abort(new Error(reason));
  };
  const externalAbort = (): void => abort('stopped', 'User stopped the runner');
  const emit = async (event: TraceInput): Promise<unknown> =>
    options.events({ ...event, data: redact(event.data, globalSecrets) });
  const lease = await options.store.acquireSupervisor({
    missionId: options.missionId,
    supervisorId,
    pid: process.pid,
    hostname: hostname(),
    leaseMs,
  });
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const supervisor: SupervisorIdentity = {
    missionId: options.missionId,
    supervisorId,
    epoch: lease.epoch,
  };
  const deadline = setTimeout(
    () => abort('resource-limit', 'Maximum elapsed time reached'),
    maxElapsedMs,
  );
  const heartbeat = (async () => {
    try {
      while (!controller.signal.aborted) {
        await delay(heartbeatMs, undefined, { signal: controller.signal });
        await options.store.renewSupervisor({ ...supervisor, leaseMs });
        const mission = await options.store.observe(options.missionId);
        if (!['active', 'closing'].includes(mission.state)) {
          abort('stopped', `Mission is ${mission.state}`);
          return;
        }
        await Promise.all(
          [...active.entries()].map(async ([agentId, principal]) => {
            try {
              await options.store.heartbeat(principal);
            } catch (error) {
              // A normal run exit can race with this snapshot. A still-active
              // generation losing its lease must stop the whole population.
              if (active.get(agentId)?.runId === principal.runId) throw error;
            }
          }),
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        fatal = error;
        abort('stalled', 'Supervisor lease or worker heartbeat failed');
      }
    }
  })();

  async function executeRun(allocation: RunAllocation): Promise<RunEnd> {
    const { principal } = allocation;
    const runDirectory = join(
      logRoot,
      options.missionId,
      safeSegment(principal.agentId),
      safeSegment(principal.runId),
    );
    const workerDirectory = join(runDirectory, 'worker');
    const invocation = buildCodexInvocation({
      repository,
      roadmapPath: options.roadmapPath,
      missionId: principal.missionId,
      slotId: principal.agentId,
      runId: principal.runId,
      generation: principal.generation,
      runDirectory: workerDirectory,
      mcpUrl: options.mcpUrl,
      runToken: allocation.token,
      codexBinary: options.codexBinary,
      model: options.model,
      environment,
      externallySandboxed: process.platform === 'darwin',
    });
    const secrets = [...globalSecrets, allocation.token];
    const promptInput = `${invocation.prompt}\n`;
    const promptText = redactedText(promptInput, secrets);
    const tracker = new CodexEventTracker();
    const manifest: RunCaptureManifest = {
      ...principal,
      schemaVersion: 1,
      finalizedAt: '',
      status: 'incomplete',
      prompt: artifactCapture(join(runDirectory, 'prompt.txt')),
      schema: artifactCapture(join(runDirectory, 'result.schema.json')),
      stdout: streamCapture(join(runDirectory, 'stdout.jsonl')),
      stderr: streamCapture(join(runDirectory, 'stderr.log')),
      result: { ...artifactCapture(join(runDirectory, 'result.json')), status: 'missing' },
      stdin: { bytes: Buffer.byteLength(promptInput), completed: false, failures: [] },
      failures: [],
    };
    const runEmit = (input: TraceInput): Promise<unknown> =>
      emit({ ...input, data: redact(input.data, secrets) });
    let child: ChildProcessWithoutNullStreams | undefined;
    let stopped: RunEnd['status'] | undefined;
    let processFailure: Error | undefined;
    let stopPromise: Promise<void> | undefined;
    let rejectStop!: (error: unknown) => void;
    const stopFailure = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    void stopFailure.catch(() => undefined);
    let capture: Promise<void>[] = [];
    let unopenedConsumers: FileHandle[] = [];
    const lifecycleWrites: Promise<unknown>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed: Promise<ProcessExit> | undefined;
    const result: RunEnd = {
      status: 'failed',
      exitCode: null,
      signal: null,
      result: null,
      reaped: false,
    };
    const terminate = options.terminate ?? terminateProcessTree;
    const stop = (status: RunEnd['status']): void => {
      if (!stopped) {
        stopped = status;
        const recorded = runEmit({
          ...principal,
          traceId: principal.runId,
          kind: 'run.stop.requested',
          data: { status },
        });
        lifecycleWrites.push(recorded);
        void recorded.catch((error: unknown) => {
          fatal ??= error;
          abort('stalled', 'Run lifecycle trace persistence failed');
        });
      }
      if (child && !stopPromise) {
        stopPromise = terminate(child);
        // A failed termination must wake the close wait, not deadlock it.
        void stopPromise.catch(rejectStop);
      }
    };
    const onAbort = (): void => stop('aborted');
    const onCaptureFailure = (error: unknown): void => {
      fatal ??= error;
      abort('stalled', 'Worker trace persistence failed');
      stop('failed');
    };
    try {
      await prepareCodexRunFiles(invocation, workerDirectory);
      // The worker sees its own result/schema directory. The audit copy of the
      // actual stdin and the complete logs are outside every writable mount.
      try {
        await persistArtifact(manifest.prompt, promptText, secrets);
        await persistArtifact(
          manifest.schema,
          `${JSON.stringify(CODEX_RESULT_SCHEMA, null, 2)}\n`,
          secrets,
        );
        await runEmit({
          ...principal,
          traceId: principal.runId,
          kind: 'run.prompt',
          data: { text: promptText, artifact: manifest.prompt },
        });
      } catch (error) {
        manifest.failures.push(captureFailure('prompt', error, secrets));
        onCaptureFailure(error);
        throw error;
      }
      const codexHome = resolve(
        environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex'),
      );
      const writablePaths = [
        ...new Set([workerDirectory, codexHome, ...(options.runtimeWritablePaths ?? [])]),
      ];
      for (const path of writablePaths) await mkdir(path, { recursive: true, mode: 0o700 });
      if (process.platform === 'darwin') {
        const temporary = join(workerDirectory, 'tmp');
        await mkdir(temporary, { mode: 0o700 });
        Object.assign(invocation.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
      }
      const hiddenPaths = [...new Set([logRoot, ...(options.hiddenPaths ?? [])])];
      for (const writable of writablePaths) {
        for (const hidden of hiddenPaths) {
          if (inside(await realpath(writable), await realpath(hidden)))
            throw new Error(
              'Writable runtime directory would expose protected daemon logs or state',
            );
        }
      }
      const spec = await (options.sandbox ?? buildSandboxInvocation)({
        repo: repository,
        argv: [invocation.command, ...invocation.args],
        cwd: repository,
        network: true,
        sourceWritable: false,
        writablePaths,
        env: Object.fromEntries(
          Object.entries(invocation.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
        hiddenPaths,
      });
      if (controller.signal.aborted) throw new Error('Runner stopped before process launch');
      for (const stream of [manifest.stdout, manifest.stderr]) {
        try {
          unopenedConsumers.push(await open(stream.path, 'ax', 0o600));
        } catch (error) {
          stream.failures.push(captureFailure('open', error, secrets));
          onCaptureFailure(error);
          throw error;
        }
      }
      await runEmit({
        ...principal,
        traceId: principal.runId,
        kind: 'run.starting',
        data: {
          supervisorId,
          epoch: supervisor.epoch,
          logDirectory: runDirectory,
          command: invocation.command,
          args: invocation.args,
        },
      });
      child = (
        options.spawn ??
        ((command, args, spawnOptions) =>
          nodeSpawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams)
      )(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: spec.detached,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      const workerProcess = child;
      closed = new Promise<ProcessExit>((resolveClose) => {
        workerProcess.once('error', (error) => {
          processFailure = error;
        });
        workerProcess.once('close', (code, signal) =>
          resolveClose({ code, signal, ...(processFailure ? { error: processFailure } : {}) }),
        );
      });
      capture = [
        captureOutput(
          child.stdout,
          'stdout',
          manifest.stdout,
          unopenedConsumers[0],
          principal,
          secrets,
          tracker,
          runEmit,
          onCaptureFailure,
        ),
        captureOutput(
          child.stderr,
          'stderr',
          manifest.stderr,
          unopenedConsumers[1],
          principal,
          secrets,
          tracker,
          runEmit,
          onCaptureFailure,
        ),
      ];
      unopenedConsumers = [];
      for (const stream of capture) void stream.catch(onCaptureFailure);
      child.stdin.on('error', (error) => {
        processFailure ??= error;
        manifest.stdin.failures.push(captureFailure('stdin', error, secrets));
        stop('failed');
      });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      timer = setTimeout(() => stop('timed-out'), runTimeoutMs);
      if (child.pid) await options.store.setPid(principal, child.pid, runDirectory);
      await runEmit({
        ...principal,
        traceId: principal.runId,
        kind: 'run.started',
        data: { pid: child.pid ?? null, logDirectory: runDirectory },
      });
      await new Promise<void>((resolveInput, rejectInput) => {
        child!.stdin.end(promptInput, (error?: Error | null) => {
          if (error) {
            if (!manifest.stdin.failures.length)
              manifest.stdin.failures.push(captureFailure('stdin', error, secrets));
            rejectInput(error);
          } else {
            manifest.stdin.completed = true;
            resolveInput();
          }
        });
      });
      const exit = await Promise.race([closed, stopFailure]);
      result.exitCode = exit.code;
      result.signal = exit.signal;
      if (stopPromise) await stopPromise;
      // Namespace teardown or the test adapter must establish descendant quiescence.
      await terminate(child);
      await Promise.all(capture);
      if (exit.error) throw exit.error;
      result.status = stopped ?? (exit.code === 0 ? 'exited' : 'failed');
    } catch (error) {
      result.status = stopped ?? 'failed';
      result.error = errorText(error, secrets);
      manifest.failures.push(captureFailure('run', error, secrets));
    } finally {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      const cleanupErrors: unknown[] = [];
      const unusedLogs = await Promise.allSettled(unopenedConsumers.map((file) => file.close()));
      for (const log of unusedLogs) if (log.status === 'rejected') cleanupErrors.push(log.reason);
      let processReaped = !child;
      try {
        if (child) {
          if (stopPromise) await stopPromise;
          await terminate(child);
          if (closed) {
            const exit = await closed;
            result.exitCode = exit.code;
            result.signal = exit.signal;
          }
          processReaped = true;
        }
      } catch (error) {
        cleanupErrors.push(error);
        manifest.failures.push(captureFailure('process-reap', error, secrets));
        fatal ??= error;
        abort('stalled', 'A worker process could not be reaped');
      }
      // Daemon-owned operations are independent of CLI pipes. Always attempt
      // their cleanup, even when process termination or output indexing failed.
      let operationsReaped = false;
      try {
        await options.stopOperations(principal);
        operationsReaped = true;
      } catch (error) {
        cleanupErrors.push(error);
        manifest.failures.push(captureFailure('operation-cleanup', error, secrets));
      }
      if (!processReaped && child) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const outputs = await Promise.allSettled(capture);
      for (const output of outputs)
        if (output.status === 'rejected') cleanupErrors.push(output.reason);
      const lifecycle = await Promise.allSettled(lifecycleWrites);
      for (const written of lifecycle)
        if (written.status === 'rejected') cleanupErrors.push(written.reason);
      result.reaped = processReaped && operationsReaped;
      // Archive the final assistant output after its producer is quiescent,
      // independently of exit status or failures in the JSON event index.
      let handoff: { result: CodexRunResult | null; text?: string } = { result: null };
      if (processReaped) {
        handoff = await captureRunResult(invocation.resultPath, manifest.result, secrets);
        result.result = handoff.result;
      } else {
        manifest.result.status = 'invalid';
        manifest.result.failures.push({
          stage: 'archive',
          code: 'RESULT_NOT_QUIESCENT',
          message: 'Final output was not read because its producer could not be reaped',
        });
      }
      if (result.status === 'exited' && manifest.result.status !== 'valid') {
        result.status = 'failed';
        result.error =
          manifest.result.failures.map((error) => error.message).join('; ') ||
          'Missing final handoff';
      }
      try {
        await runEmit({
          ...principal,
          traceId: principal.runId,
          ...traceCorrelation(tracker.current()),
          kind: 'run.handoff',
          data: {
            status: manifest.result.status,
            result: handoff.result,
            artifact: manifest.result,
            ...(handoff.text !== undefined ? { text: handoff.text } : {}),
          },
        });
      } catch (error) {
        manifest.failures.push(captureFailure('handoff-index', error, secrets));
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        result.status = 'failed';
        result.error = cleanupErrors.map((error) => errorText(error, secrets)).join('; ');
        fatal ??= cleanupErrors[0];
        abort('stalled', 'A worker or its workspace operations could not be reaped');
      }
      manifest.finalizedAt = new Date().toISOString();
      const artifacts = [
        manifest.prompt,
        manifest.schema,
        manifest.stdout,
        manifest.stderr,
        manifest.result,
      ];
      manifest.status =
        !manifest.failures.length &&
        !cleanupErrors.length &&
        artifacts.every(
          (artifact) => artifact.synced && artifact.sha256 !== null && !artifact.failures.length,
        ) &&
        manifest.stdout.eof &&
        manifest.stderr.eof &&
        manifest.stdout.indexComplete &&
        manifest.stderr.indexComplete &&
        manifest.stdin.completed &&
        !manifest.stdin.failures.length &&
        manifest.result.status === 'valid'
          ? 'complete'
          : 'incomplete';
      const writeManifest = async (): Promise<void> => {
        const temporary = artifactCapture(join(runDirectory, `capture.json.tmp-${randomUUID()}`));
        try {
          await persistArtifact(temporary, `${JSON.stringify(manifest, null, 2)}\n`, secrets);
          await rename(temporary.path, join(runDirectory, 'capture.json'));
          const directory = await open(runDirectory, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await unlink(temporary.path).catch(() => undefined);
        }
      };
      try {
        await writeManifest();
      } catch (error) {
        manifest.status = 'incomplete';
        manifest.failures.push(captureFailure('manifest', error, secrets));
        result.status = 'failed';
        result.error = errorText(error, secrets);
        fatal ??= error;
        abort('stalled', 'Capture manifest persistence failed');
      }
      try {
        await runEmit({
          ...principal,
          traceId: principal.runId,
          kind: manifest.status === 'complete' ? 'run.capture.completed' : 'run.capture.incomplete',
          data: manifest,
        });
      } catch (error) {
        manifest.status = 'incomplete';
        manifest.failures.push(captureFailure('manifest-index', error, secrets));
        result.status = 'failed';
        result.error = errorText(error, secrets);
        fatal ??= error;
        abort('stalled', 'Capture manifest indexing failed');
        await writeManifest().catch(() => undefined);
      }
      // No heartbeat can be needed after both process and operation cleanup.
      // Removing before the state update also avoids racing an in-flight tick.
      active.delete(principal.agentId);
      await options.store.endRun(principal, result);
      await runEmit({
        ...principal,
        traceId: principal.runId,
        kind: 'run.process.ended',
        data: { ...result, logDirectory: runDirectory },
      });
    }
    return result;
  }

  async function waitForAdmission(
    initial?: MissionObservation,
  ): Promise<MissionObservation | null> {
    let observation = initial ?? (await options.store.observe(options.missionId));
    const wasClosing = observation.state === 'closing';
    if (wasClosing)
      await emit({
        missionId: options.missionId,
        kind: 'admission.paused',
        data: { state: 'closing' },
      });
    while (observation.state === 'closing' && !controller.signal.aborted) {
      // The store may return closing immediately from waitForRevision. Sleep
      // here so final acceptance runs without a busy loop or new population.
      await delay(Math.min(idlePollMs, heartbeatMs), undefined, { signal: controller.signal });
      observation = await options.store.observe(options.missionId);
    }
    if (controller.signal.aborted) return null;
    if (observation.state !== 'active') {
      abort('stopped', `Mission is ${observation.state}`);
      return null;
    }
    if (wasClosing)
      await emit({
        missionId: options.missionId,
        kind: 'admission.resumed',
        data: { workRevision: observation.workRevision },
      });
    return observation;
  }

  async function slot(index: number): Promise<void> {
    const agentId = `A${index + 1}`;
    let failures = 0;
    while (!controller.signal.aborted) {
      const observed = await waitForAdmission();
      if (!observed) return;
      if (runsStarted >= maxRuns) return;
      runsStarted += 1; // Reserve synchronously before awaiting allocation.
      let allocation: RunAllocation;
      try {
        allocation = await options.store.allocateRun({ ...supervisor, agentId });
      } catch (error) {
        runsStarted -= 1;
        // Completion can close admission after the read above but before the
        // transactional allocation. This is a pause, not supervisor failure.
        const changed = await options.store.observe(options.missionId);
        if (changed.state !== 'active') {
          await waitForAdmission(changed);
          continue;
        }
        throw error;
      }
      active.set(agentId, allocation.principal);
      let end: RunEnd;
      try {
        end = await executeRun(allocation);
      } finally {
        active.delete(agentId);
      }
      runsFinished += 1;
      if (controller.signal.aborted) return;
      if (!end.reaped) throw new Error('Cannot replace an unreaped generation');
      if (runsStarted >= maxRuns) continue;
      if (end.status !== 'exited') {
        failures += 1;
        const waitMs = Math.min(backoffMs * 2 ** Math.min(failures - 1, 5), 32000);
        await emit({
          missionId: options.missionId,
          agentId,
          kind: 'slot.backoff',
          data: { failures, waitMs },
        });
        await delay(waitMs, undefined, { signal: controller.signal });
        continue;
      }
      failures = 0;
      if (end.result && ['idle', 'blocked', 'completion_proposed'].includes(end.result.outcome)) {
        // The cursor came from mesh_yield; do not replace it with a later snapshot.
        const revision = end.result.work_revision ?? observed.workRevision;
        await emit({
          missionId: options.missionId,
          agentId,
          kind: 'slot.parked',
          data: { workRevision: revision, waitingOn: end.result.waiting_on },
        });
        for (;;) {
          if (controller.signal.aborted) return;
          if (runsStarted >= maxRuns) {
            await waitForAdmission();
            return;
          }
          const next = await waitForAdmission(
            await options.store.waitForRevision(
              options.missionId,
              revision,
              idlePollMs,
              controller.signal,
            ),
          );
          if (!next) return;
          if (next.workRevision !== revision) break;
        }
        await emit({
          missionId: options.missionId,
          agentId,
          kind: 'slot.awakened',
          data: { afterRevision: revision },
        });
      }
    }
  }

  try {
    await emit({
      missionId: options.missionId,
      kind: 'supervisor.started',
      traceId: supervisorId,
      data: {
        supervisorId,
        epoch: supervisor.epoch,
        concurrency,
        maxRuns,
        maxElapsedMs,
        runTimeoutMs,
        codex: qualification,
      },
    });
    await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        slot(index).catch((error: unknown) => {
          if (!controller.signal.aborted) {
            fatal = error;
            abort('stalled', errorText(error, globalSecrets));
          }
        }),
      ),
    );
    const latest = await options.store.observe(options.missionId);
    if (controller.signal.aborted && ['active', 'closing'].includes(latest.state)) {
      await options.store.stopMission(options.missionId, abortState, abortReason);
    } else if (runsStarted >= maxRuns && latest.state === 'active') {
      await options.store.stopMission(
        options.missionId,
        'resource-limit',
        'Maximum run count reached',
      );
    }
    const final = await options.store.observe(options.missionId);
    const summary: RunnerSummary = {
      missionId: options.missionId,
      supervisorId,
      epoch: supervisor.epoch,
      runsStarted,
      runsFinished,
      state: final.state,
    };
    await emit({
      missionId: options.missionId,
      kind: 'supervisor.ended',
      traceId: supervisorId,
      data: { ...summary, ...(fatal ? { error: errorText(fatal, globalSecrets) } : {}) },
    });
    if (fatal) throw fatal;
    return summary;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', externalAbort);
    if (!controller.signal.aborted) controller.abort();
    await heartbeat;
    await options.store.releaseSupervisor(supervisor);
  }
}
