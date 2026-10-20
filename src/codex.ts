import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { coordinationInstructions } from './coordination.js';

/** The final message is a handoff, never proof that the mission is complete. */
export const CODEX_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['continue', 'idle', 'blocked', 'completion_proposed'] },
    summary: { type: 'string' },
    checkpoint_id: { type: ['string', 'null'] },
    waiting_on: { type: 'array', items: { type: 'string' } },
    work_revision: { type: ['string', 'null'] },
  },
  required: ['outcome', 'summary', 'checkpoint_id', 'waiting_on', 'work_revision'],
} as const;

export interface CodexRunResult {
  outcome: 'continue' | 'idle' | 'blocked' | 'completion_proposed';
  summary: string;
  checkpoint_id: string | null;
  waiting_on: string[];
  work_revision: string | null;
}

export interface CodexInvocationOptions {
  repository: string;
  roadmapPath: string;
  missionId: string;
  slotId: string;
  runId: string;
  generation: number;
  runDirectory: string;
  mcpUrl: string;
  runToken: string;
  codexBinary?: string;
  model?: string;
  environment?: NodeJS.ProcessEnv;
  /** macOS cannot nest Seatbelt sandboxes; the runner supplies the outer boundary. */
  externallySandboxed?: boolean;
}

export interface CodexInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  schemaPath: string;
  resultPath: string;
  promptPath: string;
}

/** JSON quoted scalar strings are also valid TOML basic strings. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function validateMeshUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash)
    throw new Error('Mesh URL must not contain credentials or a fragment');
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Mesh HTTP transport requires HTTPS outside loopback');
  }
  return url;
}

export function buildCodexInvocation(options: CodexInvocationOptions): CodexInvocation {
  if (!options.runToken || /[\r\n]/u.test(options.runToken))
    throw new Error('A nonempty valid run credential is required');
  if (!Number.isSafeInteger(options.generation) || options.generation < 1)
    throw new Error('Run generation must be a positive integer');
  validateMeshUrl(options.mcpUrl);
  const cwd = resolve(options.repository);
  const runDirectory = resolve(options.runDirectory);
  const schemaPath = join(runDirectory, 'result.schema.json');
  const resultPath = join(runDirectory, 'result.json');
  const promptPath = join(runDirectory, 'prompt.txt');
  const roadmapPath = isAbsolute(options.roadmapPath)
    ? options.roadmapPath
    : resolve(cwd, options.roadmapPath);
  const prompt = [
    'Implement the mission roadmap in this repository. Consult with the other mesh peers.',
    `Mission: ${options.missionId}. Roadmap: ${JSON.stringify(roadmapPath)}.`,
    `Your slot is ${options.slotId}; this is run ${options.runId}, generation ${options.generation}.`,
    coordinationInstructions,
  ].join('\n');

  const args = [
    'exec',
    '--ignore-user-config',
    '--cd',
    cwd,
    '--sandbox',
    options.externallySandboxed ? 'danger-full-access' : 'read-only',
    '--strict-config',
    '--ephemeral',
    '-c',
    'approval_policy="never"',
    '-c',
    'features.multi_agent=false',
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.hooks=false',
    '-c',
    'features.memories=false',
    '-c',
    'project_root_markers=[]',
    // A quoted key in a TOML value handles repository names containing dots.
    // Untrusted projects do not contribute project config, hooks, or rules.
    '-c',
    `projects={${tomlString(cwd)}={trust_level="untrusted"}}`,
    '-c',
    `mcp_servers.mesh.url=${tomlString(options.mcpUrl)}`,
    '-c',
    'mcp_servers.mesh.bearer_token_env_var="MESH_RUN_TOKEN"',
    '-c',
    'mcp_servers.mesh.required=true',
    '-c',
    'mcp_servers.mesh.enabled=true',
    '-c',
    'mcp_servers.mesh.default_tools_approval_mode="approve"',
    '--json',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    resultPath,
  ];
  if (options.model) args.push('--model', options.model);
  args.push('-');
  return {
    command: options.codexBinary ?? 'codex',
    args,
    cwd,
    env: {
      ...(options.environment ?? codexEnvironment(process.env)),
      MESH_RUN_TOKEN: options.runToken,
      MESH_MISSION_ID: options.missionId,
      MESH_SLOT_ID: options.slotId,
      MESH_RUN_ID: options.runId,
      MESH_RUN_GENERATION: String(options.generation),
      MESH_DAEMON_URL: new URL('/', options.mcpUrl).toString(),
    },
    prompt,
    schemaPath,
    resultPath,
    promptPath,
  };
}

export interface CodexQualification {
  binary: string;
  version: string;
  requiredFlags: string[];
}

export interface CodexPreflightOptions {
  codexBinary?: string;
  repository?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Read local help only. This never starts a model turn or tests authentication. */
export async function preflightCodex(
  options: CodexPreflightOptions = {},
): Promise<CodexQualification> {
  const binary = options.codexBinary ?? 'codex';
  const execute = promisify(execFile);
  const commandOptions = {
    cwd: options.repository,
    env: options.environment ?? codexEnvironment(process.env),
    timeout: options.timeoutMs ?? 10_000,
    killSignal: 'SIGKILL' as const,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8' as const,
    signal: options.signal,
  };
  const commands = [['--version'], ['exec', '--help'], ['--help']];
  const checks = await Promise.allSettled(
    commands.map((args) => execute(binary, args, commandOptions)),
  );
  const failure = checks.find((item) => item.status === 'rejected');
  if (failure?.status === 'rejected') {
    const code =
      failure.reason && typeof failure.reason === 'object'
        ? String(failure.reason.code ?? 'failed')
        : 'failed';
    throw new Error(
      `Codex CLI qualification ${code}; install a current CLI with exec --ignore-user-config and --strict-config support`,
    );
  }
  const outputs = checks.map((item) =>
    item.status === 'fulfilled' ? `${item.value.stdout}\n${item.value.stderr}` : '',
  );
  const version = outputs[0].trim();
  if (!/^codex(?:-cli)?\s+\S+/iu.test(version) || version.length > 512)
    throw new Error('Unrecognized Codex CLI version output');
  const requiredFlags = [
    '--ignore-user-config',
    '--cd',
    '--sandbox',
    '--ephemeral',
    '--json',
    '--output-schema',
    '--output-last-message',
  ];
  const missing = requiredFlags.filter((flag) => !outputs[1].includes(flag));
  if (!`${outputs[1]}\n${outputs[2]}`.includes('--strict-config')) missing.push('--strict-config');
  if (missing.length) throw new Error(`Codex CLI lacks required flags: ${missing.join(', ')}`);
  return { binary, version, requiredFlags: [...requiredFlags, '--strict-config'] };
}

export async function prepareCodexRunFiles(
  invocation: CodexInvocation,
  runDirectory: string,
): Promise<void> {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(invocation.schemaPath, `${JSON.stringify(CODEX_RESULT_SCHEMA, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(invocation.promptPath, `${invocation.prompt}\n`, { mode: 0o600 }),
  ]);
}

export function parseCodexRunResult(value: unknown): CodexRunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Codex result must be an object');
  const item = value as Record<string, unknown>;
  if (
    !['continue', 'idle', 'blocked', 'completion_proposed'].includes(String(item.outcome)) ||
    typeof item.summary !== 'string' ||
    !(item.checkpoint_id === null || typeof item.checkpoint_id === 'string') ||
    !Array.isArray(item.waiting_on) ||
    item.waiting_on.some((id) => typeof id !== 'string') ||
    !(item.work_revision === null || typeof item.work_revision === 'string') ||
    Object.keys(item).some(
      (key) =>
        !['outcome', 'summary', 'checkpoint_id', 'waiting_on', 'work_revision'].includes(key),
    )
  ) {
    throw new Error('Codex result does not match the required handoff schema');
  }
  return item as unknown as CodexRunResult;
}

/** Literal credential redaction preserves UTF-8 and catches split pipe chunks. */
export class StreamingRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private readonly secrets: string[];
  private readonly lookahead: number;
  private pending = '';
  private ended = false;

  constructor(secrets: string[] = []) {
    this.secrets = [
      ...new Set(
        secrets
          .filter((secret) => secret.length > 0)
          .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]),
      ),
    ].sort((left, right) => right.length - left.length);
    this.lookahead = Math.max(1, ...this.secrets.map((secret) => secret.length));
  }

  write(chunk: Buffer | string): string {
    if (this.ended) throw new Error('Cannot write after redactor end');
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.drain(false);
  }

  end(): string {
    if (this.ended) return '';
    this.ended = true;
    this.pending += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): string {
    const safeEnd = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.lookahead + 1);
    let offset = 0;
    const output: string[] = [];
    while (offset < safeEnd) {
      const secret = this.secrets.find((candidate) => this.pending.startsWith(candidate, offset));
      if (secret) {
        output.push('[REDACTED]');
        offset += secret.length;
      } else {
        const character = String.fromCodePoint(this.pending.codePointAt(offset)!);
        output.push(character);
        offset += character.length;
      }
    }
    this.pending = this.pending.slice(offset);
    return output.join('');
  }
}

/** Values are collected for filtering; never include this list in a trace. */
export function environmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/iu.test(key) &&
        typeof value === 'string' &&
        value.length >= 8,
    )
    .map(([, value]) => value!);
}

/** Do not pass the daemon database/admin credentials to coding processes. */
export function codexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'CODEX_HOME',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'LANG',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => names.has(key) || key.startsWith('LC_')),
  );
}
