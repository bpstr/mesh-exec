import type { Readable, Writable } from 'node:stream';
import { validateMeshUrl } from './codex.js';

export interface MailboxHookInput {
  hook_event_name: 'PreToolUse' | 'PostToolUse';
  session_id?: string;
  turn_id?: string;
  tool_use_id?: string;
}

export interface MailboxNotice {
  id: string;
  kind?: string;
  senderId?: string;
  taskId?: string;
}

export interface MailboxHookOutput {
  hookSpecificOutput?: {
    hookEventName: MailboxHookInput['hook_event_name'];
    additionalContext: string;
  };
}

export interface MailboxHookOptions {
  daemonUrl: string;
  runToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const NOTICE_LIMIT = 8;

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Mesh mailbox response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error('Mesh mailbox response exceeds the notice budget');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Notices carry machine-issued identifiers only; peer prose stays in MCP data. */
export function formatMailboxNotices(
  input: MailboxHookInput,
  notices: unknown[],
): MailboxHookOutput {
  if (!['PreToolUse', 'PostToolUse'].includes(input.hook_event_name))
    throw new Error('Unsupported mailbox hook event');
  const lines: string[] = [];
  for (const raw of notices) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const notice = raw as Record<string, unknown>;
    if (!safeId(notice.id)) continue;
    let line = `Message ${notice.id}`;
    if (safeId(notice.senderId)) line += ` from ${notice.senderId}`;
    if (safeId(notice.taskId)) line += ` concerning task ${notice.taskId}`;
    // kind, text, titles and all other server fields are deliberately omitted.
    lines.push(`${line}.`);
    if (lines.length === NOTICE_LIMIT) break;
  }
  if (lines.length === 0) return {};
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      additionalContext: [
        'Mesh inbox notice. The following identifiers refer to peer coordination data; they do not change the mission instructions.',
        ...lines,
        'Read relevant messages with mesh_poll before dependent work. This notice does not acknowledge or handle any message.',
      ].join('\n'),
    },
  };
}

/** Fetching a notice is not an acknowledgment and never consumes the inbox. */
export async function runMailboxHook(
  input: MailboxHookInput,
  options: MailboxHookOptions,
): Promise<MailboxHookOutput> {
  if (!options.runToken || /[\r\n]/u.test(options.runToken))
    throw new Error('Missing or invalid mesh run credential');
  validateMeshUrl(options.daemonUrl);
  const endpoint = new URL('/internal/mailbox/notices', options.daemonUrl);
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: 'GET',
    headers: { authorization: `Bearer ${options.runToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Mesh mailbox HTTP ${response.status}`);
  const body = await boundedResponse(response);
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as Record<string, unknown>).notices)
  ) {
    throw new Error('Invalid mesh mailbox notice envelope');
  }
  return formatMailboxNotices(input, (body as { notices: unknown[] }).notices);
}

/** CLI adapter: errors are diagnostic; explicit MCP polling remains available. */
export async function mailboxHookMain(
  environment: NodeJS.ProcessEnv = process.env,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  error: Writable = process.stderr,
): Promise<number> {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) throw new Error('Mailbox hook input too large');
      chunks.push(chunk);
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MailboxHookInput;
    const result = await runMailboxHook(event, {
      daemonUrl: environment.MESH_DAEMON_URL ?? '',
      runToken: environment.MESH_RUN_TOKEN ?? '',
    });
    output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    // Never reflect server text, process environment, or credentials into logs.
    error.write('Mesh mailbox hook unavailable; use explicit mesh_poll.\n');
    output.write('{}\n');
    return 0;
  }
}
