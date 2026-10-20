// One explicitly authorized manual pilot. The persisted grant prevents reruns.
// Automated tests must continue to use deterministic provider fixtures.
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDatabase } from '../../dist/db.js';
import { startDaemon } from '../../dist/daemon.js';
import { runMesh } from '../../dist/runner.js';
import { codexEnvironment } from '../../dist/codex.js';
import { exportMission, status, metrics } from '../../dist/observer.js';

const output = dirname(fileURLToPath(import.meta.url));
const base = '/private/tmp/mesh-exec-pilot-20261020';
const repo = join(base, 'task');
const runtimeDir = join(base, 'runtime');
const grant = {
  model: 'gpt-5.6-terra',
  agents: 5,
  maxLaunches: 5,
  maxElapsedMs: 300_000,
  replacements: false,
  retries: false,
  stop: 'completion, first provider error, or five-minute cutoff',
  authorization: 'User explicitly approved live Terra via Codex, five launches, five-minute cutoff.',
  startedAt: new Date().toISOString(),
  runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
};
await writeFile(join(output, 'authorization-consumed.json'), JSON.stringify(grant, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const controller = new AbortController();
const onSignal = () => controller.abort();
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
const db = new PgDatabase('postgresql://bpstr@127.0.0.1:5432/mesh_exec_pilot_20261020');
let daemon;
let cutoff;
try {
  daemon = await startDaemon({
    db, repo, runtimeDir, roadmapPath: 'ROADMAP.md', agents: 5, port: 0,
    config: { verification: [[process.execPath, '--test', 'slugify.test.mjs']] },
  });
  await writeFile(join(output, 'mission-id.txt'), daemon.missionId + '\n');
  console.log(JSON.stringify({ missionId: daemon.missionId, url: daemon.url, repo, runtimeDir }));
  const env = codexEnvironment(process.env);
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  cutoff = setTimeout(() => controller.abort(), grant.maxElapsedMs);
  const summary = await runMesh({
    missionId: daemon.missionId,
    repository: repo,
    roadmapPath: join(repo, 'ROADMAP.md'),
    mcpUrl: daemon.url + '/mcp',
    logRoot: join(runtimeDir, 'runs'),
    hiddenPaths: [runtimeDir],
    store: daemon.store,
    events: async (event) => {
      const saved = await daemon.store.events(event);
      if (['codex.error', 'codex.turn.failed'].includes(event.kind)) controller.abort();
      if (event.kind === 'run.process.ended' && event.data?.status === 'failed') controller.abort();
      return saved;
    },
    stopOperations: (principal) => daemon.workspace.cancelRun(principal.runId),
    concurrency: 5, maxRuns: 5, maxElapsedMs: 300_000, runTimeoutMs: 300_000,
    codexBinary: resolve(output, 'terra-launcher.sh'),
    model: grant.model,
    environment: env,
    signal: controller.signal,
  });
  await writeFile(join(output, 'runner-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} catch (error) {
  await writeFile(join(output, 'pilot-error.txt'), String(error.stack ?? error) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(cutoff);
  controller.abort();
  if (daemon) {
    await daemon.close();
    await exportMission(db, daemon.missionId, join(output, 'export'));
    await writeFile(join(output, 'status.json'), JSON.stringify(await status(db, daemon.missionId), null, 2) + '\n');
    await writeFile(join(output, 'metrics.txt'), await metrics(db, daemon.missionId));
  }
  await db.close();
  await cp(repo, join(output, 'task-result'), { recursive: true, filter: (path) => !path.endsWith('/.git') && !path.includes('/.git/') });
  await writeFile(join(output, 'finished-at.txt'), new Date().toISOString() + '\n');
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}
