import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StreamingRedactor } from './codex.js';
import { getRegisteredSecrets } from './trace.js';
import { invariant } from './types.js';

const CHUNK_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

export interface FileIntegrity {
  bytes: number;
  sha256: string;
}

export interface CopiedArtifact extends FileIntegrity {
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  sourceSizeAtOpen: number;
  sourceSizeAtClose: number;
  offsetsPreserved: boolean;
  partial: boolean;
  reasons: string[];
}

export interface ExportArtifact extends FileIntegrity {
  path: string;
  sourcePath?: string;
  sourceBytes?: number;
  sourceSha256?: string;
  sourceSizeAtOpen?: number;
  sourceSizeAtClose?: number;
  offsetsPreserved?: boolean;
  partial?: boolean;
  reasons?: string[];
  integrity?: 'verified' | 'mismatch' | 'unverified';
  expected?: Partial<FileIntegrity>;
  runId?: string;
  operationId?: string;
}

/** The file descriptor applies backpressure; no complete artifact is buffered. */
export class ArtifactWriter {
  private readonly hash = createHash('sha256');
  private bytes = 0;
  private closed = false;
  private constructor(
    private readonly path: string,
    private readonly file: FileHandle,
  ) {}

  static async open(path: string): Promise<ArtifactWriter> {
    await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    return new ArtifactWriter(path, await open(path, 'wx', 0o600));
  }

  async write(content: string | Buffer): Promise<void> {
    invariant(!this.closed, 'ARTIFACT_CLOSED', 'The artifact writer is closed');
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    await this.file.writeFile(bytes);
    this.hash.update(bytes);
    this.bytes += bytes.length;
  }

  async finish(): Promise<FileIntegrity> {
    invariant(!this.closed, 'ARTIFACT_CLOSED', 'The artifact writer is closed');
    await this.file.sync();
    await this.file.close();
    this.closed = true;
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }

  async abort(): Promise<void> {
    if (!this.closed) await this.file.close().catch(() => undefined);
    this.closed = true;
    await unlink(this.path).catch(() => undefined);
  }
}

/**
 * Pattern filtering is a state machine instead of a fixed trailing window:
 * bearer/API tokens and URI passwords have no maximum length. Once a credential
 * begins, its remainder is suppressed without retaining it in memory.
 */
export class ArtifactRedactor {
  private readonly literals: StreamingRedactor;
  private pending = '';
  private previousWord = false;
  private mode: 'normal' | 'bearer-gap' | 'bearer-token' | 'api-token' | 'pg-user' | 'pg-password' =
    'normal';
  private pgUser = false;
  private pgPassword = false;
  private pendingPassword = '';

  constructor(secrets: string[] = getRegisteredSecrets()) {
    this.literals = new StreamingRedactor(secrets);
  }

  write(chunk: Buffer | string): string {
    this.pending += this.literals.write(chunk);
    return this.drain(false);
  }

  end(): string {
    this.pending += this.literals.end();
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let offset = 0;
    const result: string[] = [];
    const consume = (length: number) => {
      this.previousWord = /[A-Za-z0-9_]/u.test(this.pending[offset + length - 1] ?? '');
      offset += length;
    };
    while (offset < this.pending.length) {
      const char = String.fromCodePoint(this.pending.codePointAt(offset)!);
      if (this.mode === 'bearer-gap') {
        if (/\s/u.test(char)) {
          result.push(char);
          consume(char.length);
          continue;
        }
        if (/[A-Za-z0-9._~+\/-]/u.test(char)) {
          result.push('[REDACTED]');
          this.mode = 'bearer-token';
          consume(char.length);
          continue;
        }
        this.mode = 'normal';
      }
      if (this.mode === 'bearer-token' || this.mode === 'api-token') {
        const token = this.mode === 'bearer-token' ? /[A-Za-z0-9._~+\/-]/u : /[A-Za-z0-9_-]/u;
        if (token.test(char)) {
          consume(char.length);
          continue;
        }
        this.mode = 'normal';
      }
      if (this.mode === 'pg-user') {
        if (!/[:\s/]/u.test(char)) {
          result.push(char);
          this.pgUser = true;
          consume(char.length);
          continue;
        }
        if (char === ':' && this.pgUser) {
          result.push(':');
          this.mode = 'pg-password';
          this.pgPassword = false;
          this.pendingPassword = '';
          consume(1);
          continue;
        }
        this.mode = 'normal';
      }
      if (this.mode === 'pg-password') {
        if (char === '@') {
          if (!this.pgPassword && this.pendingPassword) result.push('[REDACTED]');
          this.pendingPassword = '';
          result.push('@');
          this.mode = 'normal';
          consume(1);
          continue;
        }
        if (!/\s/u.test(char)) {
          if (!this.pgPassword) {
            this.pendingPassword += char;
            // Keep ordinary host:port URLs unchanged when no credentials follow.
            // Oversized unresolved candidates are suppressed conservatively.
            if (this.pendingPassword.length > CHUNK_BYTES) {
              result.push('[REDACTED]');
              this.pendingPassword = '';
              this.pgPassword = true;
            }
          }
          consume(char.length);
          continue;
        }
        if (!this.pgPassword) result.push(this.pendingPassword);
        this.pendingPassword = '';
        this.mode = 'normal';
      }
      if (!this.previousWord) {
        const rest = this.pending.slice(offset, offset + 19);
        const lower = rest.toLowerCase();
        const prefixes = ['bearer', 'postgres://', 'postgresql://'];
        if (
          !final &&
          prefixes.some((prefix) => lower.length < prefix.length && prefix.startsWith(lower))
        )
          break;
        if (lower.startsWith('bearer')) {
          if (rest.length === 6 && !final) break;
          if (/\s/u.test(rest[6] ?? '')) {
            result.push(rest.slice(0, 6));
            consume(6);
            this.mode = 'bearer-gap';
            continue;
          }
        }
        const postgres = lower.startsWith('postgresql://')
          ? 'postgresql://'
          : lower.startsWith('postgres://')
            ? 'postgres://'
            : undefined;
        if (postgres) {
          result.push(rest.slice(0, postgres.length));
          consume(postgres.length);
          this.mode = 'pg-user';
          this.pgUser = false;
          continue;
        }
        if ('sk-'.startsWith(rest) && rest.length < 3 && !final) break;
        if (rest.startsWith('sk-')) {
          const candidate = rest.slice(3, 19);
          if (candidate.length < 16 && /^[A-Za-z0-9_-]*$/u.test(candidate) && !final) break;
          if (/^[A-Za-z0-9_-]{16}$/u.test(candidate)) {
            result.push('[REDACTED]');
            consume(19);
            this.mode = 'api-token';
            continue;
          }
        }
      }
      result.push(char);
      consume(char.length);
    }
    if (final && this.mode === 'pg-password' && !this.pgPassword) {
      result.push(this.pendingPassword);
      this.pendingPassword = '';
    }
    this.pending = this.pending.slice(offset);
    return result.join('');
  }
}

/** Copy exactly the initial file-size prefix, even if a live writer keeps appending. */
export async function copyArtifact(input: {
  source: string;
  target: string;
  secrets?: string[];
}): Promise<CopiedArtifact> {
  const source = await open(
    input.source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let writer: ArtifactWriter | undefined;
  try {
    const before = await source.stat();
    invariant(before.isFile(), 'INVALID_ARTIFACT', 'Artifacts must be regular files');
    invariant(
      Number.isSafeInteger(before.size),
      'ARTIFACT_TOO_LARGE',
      'Artifact size exceeds supported file offsets',
    );
    writer = await ArtifactWriter.open(input.target);
    const rawHash = createHash('sha256');
    const redactor = new ArtifactRedactor(input.secrets);
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let sourceBytes = 0;
    while (sourceBytes < before.size) {
      const read = await source.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - sourceBytes),
        sourceBytes,
      );
      if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      rawHash.update(chunk);
      sourceBytes += read.bytesRead;
      await writer.write(redactor.write(chunk));
    }
    await writer.write(redactor.end());
    const after = await source.stat();
    const sourceSha256 = rawHash.digest('hex');
    const output = await writer.finish();
    const reasons: string[] = [];
    if (sourceBytes !== before.size) reasons.push('Source ended before its captured initial size');
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      reasons.push('Source changed during the bounded copy');
    return {
      ...output,
      sourcePath: resolve(input.source),
      sourceBytes,
      sourceSha256,
      sourceSizeAtOpen: before.size,
      sourceSizeAtClose: after.size,
      offsetsPreserved: sourceBytes === output.bytes && sourceSha256 === output.sha256,
      partial: reasons.length > 0,
      reasons,
    };
  } catch (error) {
    await writer?.abort();
    throw error;
  } finally {
    await source.close();
  }
}

export async function digestFile(path: string): Promise<FileIntegrity> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    invariant(before.isFile(), 'INVALID_ARTIFACT', 'Artifacts must be regular files');
    invariant(
      Number.isSafeInteger(before.size),
      'ARTIFACT_TOO_LARGE',
      'Artifact size exceeds supported file offsets',
    );
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let bytes = 0;
    while (bytes < before.size) {
      const read = await file.read(buffer, 0, Math.min(buffer.length, before.size - bytes), bytes);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    const after = await file.stat();
    invariant(
      bytes === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      'ARTIFACT_CHANGED',
      'Artifact changed during bounded integrity verification',
    );
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

const requiredTopLevelArtifacts = new Set([
  'mission.json',
  'events.jsonl',
  'runs.json',
  'operations.json',
  'tasks.json',
  'messages.json',
  'a2a-messages.json',
  'outbox.json',
  'attempts.json',
  'exposures.json',
]);
// Older format-version 1 bundles predate the work and uptake ledger snapshots.
const topLevelArtifacts = new Set([...requiredTopLevelArtifacts, 'work.json', 'uptakes.json']);

function allowedArchivePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (parts.length === 1) return topLevelArtifacts.has(path);
  if (parts.length !== 3) return false;
  if (parts[0] === 'runs')
    return [
      'stdout.jsonl',
      'stderr.log',
      'events.jsonl',
      'result.json',
      'prompt.txt',
      'result.schema.json',
      'capture.json',
    ].includes(parts[2]);
  return (
    parts[0] === 'operations' && ['stdout.log', 'stderr.log', 'capture.json'].includes(parts[2])
  );
}

async function archivePath(root: string, path: string, manifest = false): Promise<string> {
  invariant(
    manifest ? path === 'export.json' : allowedArchivePath(path),
    'UNSAFE_ARCHIVE_PATH',
    `Unsupported artifact path: ${path}`,
  );
  const target = resolve(root, path);
  const remainder = relative(root, target);
  invariant(
    remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder),
    'UNSAFE_ARCHIVE_PATH',
    'Artifact path leaves its archive',
  );
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const information = await lstat(current);
    invariant(
      !information.isSymbolicLink(),
      'UNSAFE_ARCHIVE_PATH',
      `Archive symlinks are not followed: ${path}`,
    );
  }
  return target;
}

export interface ExportVerification {
  valid: boolean;
  checked: number;
  missing: string[];
  mismatched: Array<{ path: string; expected: FileIntegrity; actual: FileIntegrity }>;
  errors: string[];
  partial: boolean;
}

/** Hashes detect missing/changed archived bytes; the inventory is not a signature. */
export async function verifyExport(directory: string): Promise<ExportVerification> {
  const result: ExportVerification = {
    valid: false,
    checked: 0,
    missing: [],
    mismatched: [],
    errors: [],
    partial: false,
  };
  try {
    const root = await realpath(directory);
    const manifest = await open(
      await archivePath(root, 'export.json', true),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let parsed: Record<string, unknown>;
    try {
      const information = await manifest.stat();
      invariant(
        information.isFile() && information.size <= MAX_MANIFEST_BYTES,
        'INVALID_EXPORT_MANIFEST',
        'Export inventory exceeds the 32 MiB metadata budget or is not a file',
      );
      const bytes = Buffer.alloc(information.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await manifest.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await manifest.stat();
      invariant(
        offset === information.size &&
          after.size === information.size &&
          after.mtimeMs === information.mtimeMs,
        'INVALID_EXPORT_MANIFEST',
        'Export inventory changed while being read',
      );
      parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } finally {
      await manifest.close();
    }
    invariant(
      parsed.formatVersion === 1 && Array.isArray(parsed.artifacts),
      'INVALID_EXPORT_MANIFEST',
      'Unsupported export inventory format',
    );
    result.partial =
      parsed.partial === true || (Array.isArray(parsed.missing) && parsed.missing.length > 0);
    const seen = new Set<string>();
    for (const raw of parsed.artifacts) {
      const item = raw as ExportArtifact;
      try {
        invariant(
          item &&
            typeof item.path === 'string' &&
            Number.isSafeInteger(item.bytes) &&
            item.bytes >= 0 &&
            /^[a-f0-9]{64}$/u.test(item.sha256),
          'INVALID_EXPORT_MANIFEST',
          'Invalid artifact integrity metadata',
        );
        invariant(
          !seen.has(item.path),
          'INVALID_EXPORT_MANIFEST',
          `Duplicate artifact path: ${item.path}`,
        );
        seen.add(item.path);
        const actual = await digestFile(await archivePath(root, item.path));
        result.checked++;
        if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256)
          result.mismatched.push({
            path: item.path,
            expected: { bytes: item.bytes, sha256: item.sha256 },
            actual,
          });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          result.missing.push(item?.path ?? '<unknown>');
        else result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const required of requiredTopLevelArtifacts)
      if (!seen.has(required))
        result.errors.push(`Required inventory entry is missing: ${required}`);
    result.valid = !result.missing.length && !result.mismatched.length && !result.errors.length;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}
