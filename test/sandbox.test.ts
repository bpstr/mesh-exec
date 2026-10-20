import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { assertSandboxAvailable, buildSandboxInvocation } from '../src/sandbox.js';

const exec = promisify(execFile);

test('OS sandbox isolates private audit files while permitting worker output and guarded source commands', async (t) => {
  try {
    await assertSandboxAvailable();
  } catch (error) {
    if (process.env.MESH_REQUIRE_SANDBOX === '1') throw error;
    t.skip(String(error));
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'mesh-sandbox-'));
  const repo = join(directory, 'repo');
  const runtime = join(directory, 'private');
  const worker = join(runtime, 'worker');
  try {
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(worker, { recursive: true });
    await writeFile(join(runtime, 'audit.log'), 'private audit');
    await writeFile(join(repo, '.git', 'config'), 'preserve');
    const script = `
      const fs = require('node:fs'), assert = require('node:assert/strict');
      fs.writeFileSync(${JSON.stringify(join(worker, 'result.json'))}, 'handoff');
      assert.throws(() => fs.readFileSync(${JSON.stringify(join(runtime, 'audit.log'))}));
      // Linux hides this path behind a disposable tmpfs; macOS denies access.
      // Either way the real host audit file must remain unchanged below.
      try { fs.writeFileSync(${JSON.stringify(join(runtime, 'audit.log'))}, 'bad'); } catch {}
      assert.throws(() => fs.writeFileSync('.git/config', 'bad'));
      fs.writeFileSync('output.txt', 'authorized');
    `;
    const invocation = await buildSandboxInvocation({
      repo,
      argv: [process.execPath, '-e', script],
      writablePaths: [worker],
      hiddenPaths: [runtime],
      sourceWritable: true,
      network: false,
    });
    await exec(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeout: 10_000,
    });
    assert.equal(await readFile(join(worker, 'result.json'), 'utf8'), 'handoff');
    assert.equal(await readFile(join(runtime, 'audit.log'), 'utf8'), 'private audit');
    assert.equal(await readFile(join(repo, '.git', 'config'), 'utf8'), 'preserve');
    assert.equal(await readFile(join(repo, 'output.txt'), 'utf8'), 'authorized');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
