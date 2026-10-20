import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MeshError, invariant } from './types.js';

export interface SandboxOptions {
  repo: string;
  argv: string[];
  writablePaths: string[];
  readOnlyPaths?: string[];
  cwd?: string;
  network?: boolean;
  sourceWritable?: boolean;
  env?: Record<string, string>;
  hiddenPaths?: string[];
}

export interface SandboxInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: true;
}

export function isWithin(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return (
    remainder === '' ||
    (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
  );
}

let qualification: Promise<void> | undefined;

/** An installed binary is not proof that the host permits its namespaces. */
export function assertSandboxAvailable(): Promise<void> {
  qualification ??= new Promise<void>((accept, reject) => {
    if (process.platform !== 'linux') {
      reject(
        new MeshError(
          'sandbox_unavailable',
          'The enforced worker boundary currently requires Linux and bubblewrap.',
        ),
      );
      return;
    }
    const child = spawn(
      'bwrap',
      [
        '--die-with-parent',
        '--unshare-pid',
        '--unshare-net',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--',
        '/bin/true',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
    );
    let diagnostic = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* close/error carries the failure */
      }
      reject(new MeshError('sandbox_unavailable', 'Bubblewrap qualification timed out.'));
    }, 8000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new MeshError('sandbox_unavailable', `Cannot launch bubblewrap: ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) accept();
      else
        reject(
          new MeshError(
            'sandbox_unavailable',
            'The host cannot create the required bubblewrap namespace.',
            { diagnostic, code },
          ),
        );
    });
  });
  return qualification;
}

/** All writable mounts are explicit. No unrestricted execution fallback exists. */
export async function buildSandboxInvocation(options: SandboxOptions): Promise<SandboxInvocation> {
  await assertSandboxAvailable();
  invariant(
    options.argv.length > 0 &&
      options.argv.every((value) => typeof value === 'string' && !value.includes('\0')),
    'invalid_command',
    'A command must be a nonempty argument array without NUL bytes.',
  );
  const repo = await realpath(options.repo);
  const cwd = await realpath(options.cwd ?? repo);
  invariant(
    isWithin(repo, cwd),
    'invalid_cwd',
    'Command working directories must be within the shared checkout.',
  );
  const writablePaths: string[] = [];
  for (const path of options.writablePaths) {
    const canonical = await realpath(path);
    invariant(
      !isWithin(repo, canonical) && !isWithin(canonical, repo),
      'unsafe_writable_mount',
      'Runtime writable mounts cannot include the checkout or any of its ancestors.',
    );
    writablePaths.push(canonical);
  }
  const hiddenPaths = (options.hiddenPaths ?? []).map((path) => resolve(path));
  for (const path of hiddenPaths) {
    invariant(
      path !== '/' && !isWithin(path, repo),
      'unsafe_hidden_mount',
      'A hidden mount cannot cover the checkout.',
    );
  }

  const args = [
    '--die-with-parent',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  if (!options.network) args.push('--unshare-net');
  for (const path of hiddenPaths) args.push('--tmpfs', path);
  for (const path of options.readOnlyPaths ?? []) {
    const canonical = await realpath(path);
    args.push('--ro-bind', canonical, canonical);
  }
  args.push(options.sourceWritable ? '--bind' : '--ro-bind', repo, repo);
  // Even source-generating commands cannot stage files or change refs.
  const gitPath = resolve(repo, '.git');
  try {
    await lstat(gitPath);
    args.push('--ro-bind', gitPath, gitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const path of writablePaths) args.push('--bind', path, path);
  args.push('--chdir', cwd, '--', ...options.argv);

  // In particular, a daemon's DATABASE_URL and other credentials are not inherited.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TERM']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, options.env ?? {});
  return { command: 'bwrap', args, cwd, env, detached: true };
}

/**
 * Callers must attach their own `close` listener immediately when spawning.
 * The child must be a detached bubblewrap leader: killing its PID namespace also
 * terminates descendants which have changed their process group or session.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: { graceMs?: number; forceMs?: number } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) {
    // A spawn error has no namespace or descendants to reap.
    if ((child as ChildProcess & { pid?: number }).pid === undefined) return;
  }
  const pid = child.pid!;
  let closed = false;
  let notify: (() => void) | undefined;
  const closure = new Promise<void>((accept) => {
    notify = accept;
  });
  const onClose = () => {
    closed = true;
    notify?.();
  };
  child.once('close', onClose);
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      try {
        process.kill(pid, name);
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code !== 'ESRCH') throw fallback;
      }
    }
  };
  const wait = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closure,
      new Promise<void>((accept) => {
        timer = setTimeout(accept, milliseconds);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };
  try {
    signal('SIGTERM');
    await wait(options.graceMs ?? 2000);
    if (!closed) {
      signal('SIGKILL');
      await wait(options.forceMs ?? 4000);
    }
    if (!closed)
      throw new MeshError(
        'termination_unconfirmed',
        'The command namespace has not been confirmed stopped.',
        { pid },
      );
  } finally {
    child.off('close', onClose);
  }
}
