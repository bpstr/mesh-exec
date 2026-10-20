import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { A2aService, A2A_SCHEMA } from './a2a.js';
import { Workspace, WORKSPACE_SCHEMA, type WorkspaceOptions } from './workspace.js';
import { Store } from './store.js';
import { Completion } from './completion.js';
import { MeshTools } from './tools.js';
import { readEvents, registerSecret, redact } from './trace.js';
import { metrics, status, messages } from './observer.js';
import { invariant, type Database, type EventSink, type Principal } from './types.js';

export interface DaemonOptions {
  db: Database;
  repo: string;
  runtimeDir: string;
  roadmapPath?: string;
  agents?: number;
  resume?: string;
  port?: number;
  config?: Record<string, unknown>;
  maxCommands?: number;
  workspace?: Partial<Pick<WorkspaceOptions, 'commandBuilder' | 'terminate' | 'lockDirectory'>>;
}
export interface RunningDaemon {
  missionId: string;
  url: string;
  operatorToken: string;
  runtimeDir: string;
  store: Store;
  workspace: Workspace;
  a2a: A2aService;
  completion: Completion;
  server: Server;
  close(): Promise<void>;
}
const bearer = (request: express.Request): string =>
  request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1] ?? '';

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const repo = await realpath(options.repo);
  const runtimeDir = resolve(options.runtimeDir);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const store = new Store(options.db);
  await store.initialize();
  await options.db.query(A2A_SCHEMA);
  await options.db.query(WORKSPACE_SCHEMA);
  const workspaceEvents: EventSink = async (event, tx) => {
    const result = await store.events(event, tx);
    const data = event.data as
      { result?: { files?: { path: string }[]; sourceChanged?: boolean } } | undefined;
    if (event.kind === 'workspace.operation.applied')
      await store.invalidateFiles(
        event.missionId,
        data?.result?.files?.map((f) => f.path) ?? ['*'],
        tx,
      );
    else if (
      [
        'workspace.operation.succeeded',
        'workspace.operation.failed',
        'workspace.operation.cancelled',
      ].includes(event.kind)
    ) {
      if (data?.result?.sourceChanged) await store.invalidateFiles(event.missionId, ['*'], tx);
      else if (!event.runId?.startsWith('verification:')) {
        if (tx) await store.changed(tx, event.missionId);
        else await store.db.transaction((sql) => store.changed(sql, event.missionId));
      }
    }
    return result;
  };
  const workspace = await Workspace.open({
    repo,
    runtimeDir: join(runtimeDir, 'workspace'),
    db: options.db,
    events: workspaceEvents,
    authorize: (...args) => store.authorize(...args),
    maxCommands: options.maxCommands,
    ...options.workspace,
  });
  let server: Server | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let completion: Completion | undefined;
  try {
    let missionId: string;
    if (options.resume) {
      const mission = await store.mission(options.resume);
      invariant(
        mission.repo === repo,
        'WRONG_CHECKOUT',
        'The mission belongs to another physical checkout',
      );
      invariant(
        mission.state !== 'completed',
        'ALREADY_COMPLETED',
        'This mission already completed',
      );
      await store.recoverRuns(mission.id);
      await options.db.transaction(async (tx) => {
        await store.lock(tx, mission.id);
        await tx.query(
          "UPDATE completion_proposals SET state='failed',error=$2::jsonb WHERE mission_id=$1 AND state IN ('queued','running')",
          [
            mission.id,
            JSON.stringify({
              message: 'Supervisor interrupted; submit a new completion proposal after review',
            }),
          ],
        );
        await tx.query("UPDATE missions SET state='active',revision=revision+1 WHERE id=$1", [
          mission.id,
        ]);
        await store.events({ missionId: mission.id, kind: 'mission.resumed', data: { repo } }, tx);
      });
      missionId = mission.id;
    } else {
      invariant(options.roadmapPath, 'ROADMAP_REQUIRED', 'Specify a roadmap for a new mission');
      const roadmapPath = resolve(repo, options.roadmapPath);
      const roadmapText = await readFile(roadmapPath, 'utf8');
      invariant(roadmapText.trim().length > 0, 'EMPTY_ROADMAP', 'The roadmap must contain a goal');
      const baseline = await workspace.manifest();
      const mission = await store.createMission({
        repo,
        roadmapPath,
        roadmapText,
        baseline,
        agents: options.agents ?? 10,
        config: options.config,
      });
      missionId = mission.id;
    }
    const operatorToken = randomBytes(32).toString('base64url');
    registerSecret(operatorToken);
    const app = express();
    app.disable('x-powered-by');
    let ready = false;
    let url = '';
    app.use((req, res, next) => {
      const hostname = req.headers.host?.split(':')[0];
      if (!['127.0.0.1', 'localhost'].includes(hostname ?? '') || req.headers.origin) {
        res.status(403).json({ error: 'Only direct local clients are accepted' });
        return;
      }
      next();
    });
    app.get('/health', (_req, res) =>
      res.status(ready ? 200 : 503).json({ ready, service: 'mesh-exec' }),
    );
    server = createServer(app);
    await new Promise<void>((accept, reject) => {
      server!.once('error', reject);
      server!.listen(options.port ?? 7331, '127.0.0.1', () => {
        server!.off('error', reject);
        accept();
      });
    });
    const address = server.address();
    invariant(
      address && typeof address !== 'string',
      'LISTEN_FAILED',
      'Daemon did not bind a local port',
    );
    url = `http://127.0.0.1:${address.port}`;
    const a2a = new A2aService({
      db: options.db,
      events: store.events,
      authenticate: (token) => store.authenticate(token),
      validatePrincipal: (tx, p) => store.assertActive(p, tx, true),
      peerExists: async (tx, m, a) =>
        (await tx.query('SELECT id FROM slots WHERE mission_id=$1 AND id=$2', [m, a])).rowCount > 0,
      baseUrl: url,
    });
    completion = new Completion(store, workspace);
    const meshTools = new MeshTools(store, a2a, workspace, completion);
    const a2aRouter = a2a.router();
    app.use((req, res, next) => {
      if (req.path.startsWith('/agents/')) a2aRouter(req, res, next);
      else next();
    });
    app.use(express.json({ limit: '12mb' }));
    const authenticate = async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      try {
        res.locals.principal = await store.authenticate(bearer(req));
        next();
      } catch (error) {
        await store
          .events({
            missionId,
            kind: 'auth.rejected',
            data: { path: req.path, reason: (error as Error).message },
          })
          .catch(() => {});
        res.status(401).json({ error: 'A current mesh run credential is required' });
      }
    };
    app.post('/mcp', authenticate, async (req, res) => {
      const mcp = meshTools.server(res.locals.principal as Principal);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        if (!res.headersSent)
          res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id ?? null,
            error: { code: -32603, message: 'Mesh transport failed' },
          });
      }
    });
    app.all('/mcp', authenticate, (_req, res) =>
      res.status(405).json({ error: 'This stateless MCP endpoint accepts POST requests' }),
    );
    app.get('/internal/mailbox/notices', authenticate, async (_req, res) => {
      const r = await a2a.notices(res.locals.principal as Principal);
      res.json({
        notices: r.messages.map((m) => ({
          id: m.deliveryId,
          senderId: m.from,
          taskId: m.taskId,
          kind: m.kind,
        })),
        workRevision: r.workRevision,
      });
    });
    const operator = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const actual = Buffer.from(bearer(req));
      const expected = Buffer.from(operatorToken);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.status(401).json({ error: 'Operator credential required' });
        return;
      }
      next();
    };
    app.get('/observer/status', operator, async (_req, res) =>
      res.json(await status(options.db, missionId)),
    );
    app.get('/observer/events', operator, async (req, res) =>
      res.json(
        await readEvents(options.db, missionId, {
          after: String(req.query.after ?? '0'),
          limit: Number(req.query.limit ?? 200),
          agent: req.query.agent as string | undefined,
          run: req.query.run as string | undefined,
          task: req.query.task as string | undefined,
          message: req.query.message as string | undefined,
          operation: req.query.operation as string | undefined,
          kind: req.query.kind as string | undefined,
        }),
      ),
    );
    app.get('/observer/messages', operator, async (req, res) =>
      res.json(
        await messages(options.db, missionId, {
          agent: req.query.agent as string | undefined,
          task: req.query.task as string | undefined,
          pending: req.query.pending === 'true',
        }),
      ),
    );
    app.get('/metrics', operator, async (_req, res) =>
      res.type('text/plain; version=0.0.4').send(await metrics(options.db, missionId)),
    );
    app.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        if (!res.headersSent)
          res
            .status(500)
            .json({ error: redact(error instanceof Error ? error.message : String(error)) });
      },
    );
    let reconcileWork: Promise<unknown> | undefined;
    reconcileTimer = setInterval(() => {
      if (reconcileWork) return;
      reconcileWork = a2a
        .reconcileOutbox()
        .catch((error) =>
          store.events({
            missionId,
            kind: 'outbox.reconcile.failed',
            data: { error: String(error) },
          }),
        )
        .catch(() => {})
        .finally(() => {
          reconcileWork = undefined;
        });
    }, 1000);
    reconcileTimer.unref();
    await writeFile(
      join(runtimeDir, 'daemon.json'),
      JSON.stringify({ missionId, url, operatorToken, pid: process.pid, repo }, null, 2) + '\n',
      { mode: 0o600 },
    );
    await store.events({ missionId, kind: 'daemon.ready', data: { url, repo, pid: process.pid } });
    ready = true;
    let closed = false;
    return {
      missionId,
      url,
      operatorToken,
      runtimeDir,
      store,
      workspace,
      a2a,
      completion,
      server,
      close: async () => {
        if (closed) return;
        closed = true;
        ready = false;
        if (reconcileTimer) clearInterval(reconcileTimer);
        await reconcileWork;
        server!.closeIdleConnections();
        const stopHttp = new Promise<void>((accept) => server!.close(() => accept()));
        await workspace.close();
        await completion!.close();
        server!.closeAllConnections();
        await stopHttp;
        await store.events({ missionId, kind: 'daemon.stopped', data: {} });
      },
    };
  } catch (error) {
    if (reconcileTimer) clearInterval(reconcileTimer);
    server?.closeAllConnections();
    server?.close();
    await workspace.close();
    throw error;
  }
}
