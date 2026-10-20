import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { A2aService, A2A_SCHEMA } from './a2a.js';
import { Workspace, WORKSPACE_SCHEMA, type WorkspaceOptions } from './workspace.js';
import { Store } from './store.js';
import { Completion } from './completion.js';
import { MeshTools } from './tools.js';
import { readEvents, registerSecret, redact, type TraceFilter } from './trace.js';
import { metrics, status, messages } from './observer.js';
import { listConversationMessages, conversationTimeline } from './conversations.js';
import { listRuns } from './runs.js';
import { writeOutput } from './streams.js';
import { invariant, MeshError, type Database, type EventSink, type Principal } from './types.js';

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
  maxQueuedCommands?: number;
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

function queryText(query: Record<string, unknown>, name: string): string | undefined {
  const value = query[name];
  invariant(
    value === undefined || (typeof value === 'string' && value.length <= 4096),
    'INVALID_QUERY',
    `${name} must be a single string of at most 4096 characters`,
  );
  return value as string | undefined;
}
function eventQuery(query: Record<string, unknown>): TraceFilter {
  const limit = queryText(query, 'limit');
  return {
    after: queryText(query, 'after'),
    until: queryText(query, 'until'),
    limit: limit === undefined ? 200 : Number(limit),
    agent: queryText(query, 'agent'),
    run: queryText(query, 'run'),
    task: queryText(query, 'task'),
    message: queryText(query, 'message'),
    operation: queryText(query, 'operation'),
    correlation: queryText(query, 'correlation'),
    traceId: queryText(query, 'traceId'),
    spanId: queryText(query, 'spanId'),
    kind: queryText(query, 'kind'),
    kindPrefix: queryText(query, 'kindPrefix'),
  };
}
function conversationQuery(query: Record<string, unknown>) {
  const limit = queryText(query, 'limit');
  return {
    agent: queryText(query, 'agent'),
    task: queryText(query, 'task'),
    message: queryText(query, 'message'),
    outbox: queryText(query, 'outbox'),
    state: queryText(query, 'state'),
    cursor: queryText(query, 'cursor'),
    limit: limit === undefined ? undefined : Number(limit),
  };
}

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
    maxQueuedCommands: options.maxQueuedCommands,
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
    const workflow = (await store.mission(missionId)).config.workflow ?? 'implementation';
    invariant(
      workflow === 'implementation' || workflow === 'discussion',
      'INVALID_WORKFLOW',
      'Workflow must be implementation or discussion',
    );
    const meshTools = new MeshTools(store, a2a, workspace, completion, workflow);
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
        // Only MCP has a narrow post-acceptance tool allowlist. A2A/mailbox
        // authentication retains the active/closing-only policy.
        res.locals.principal = await store.authenticate(bearer(req), req.path === '/mcp');
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
    app.get('/observer/runs', operator, async (req, res) => {
      const limit = queryText(req.query, 'limit');
      res.json(
        await listRuns(options.db, missionId, {
          agent: queryText(req.query, 'agent'),
          run: queryText(req.query, 'run'),
          state: queryText(req.query, 'state'),
          cursor: queryText(req.query, 'cursor'),
          limit: limit === undefined ? undefined : Number(limit),
        }),
      );
    });
    app.get('/observer/events', operator, async (req, res) =>
      res.json(await readEvents(options.db, missionId, eventQuery(req.query))),
    );
    app.get('/observer/events/stream', operator, async (req, res) => {
      const filter = eventQuery(req.query);
      filter.after ??= req.get('Last-Event-ID') ?? '0';
      // Validate the query before committing SSE headers so invalid cursors return 400.
      let batch = await readEvents(options.db, missionId, filter);
      if (res.destroyed) return;
      const abort = new AbortController();
      const onClose = () => abort.abort();
      res.once('close', onClose);
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      let heartbeat = Date.now();
      try {
        await writeOutput(res, 'retry: 1000\n\n', abort.signal);
        while (!abort.signal.aborted) {
          for (const event of batch) {
            if (
              !(await writeOutput(
                res,
                `id: ${event.seq}\nevent: mesh.trace\ndata: ${JSON.stringify(event)}\n\n`,
                abort.signal,
              ))
            )
              return;
            filter.after = event.seq;
          }
          const caughtUp = batch.length < Math.min(filter.limit ?? 200, 2000);
          if (filter.until !== undefined && caughtUp) break;
          if (Date.now() - heartbeat >= 16_000) {
            if (!(await writeOutput(res, ': keepalive\n\n', abort.signal))) return;
            heartbeat = Date.now();
          }
          if (caughtUp) await delay(500, undefined, { signal: abort.signal });
          if (!abort.signal.aborted) batch = await readEvents(options.db, missionId, filter);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          // Never silently end a stream after a database/read failure.
          await writeOutput(
            res,
            `event: mesh.error\ndata: ${JSON.stringify(
              redact({
                error: error instanceof Error ? error.message : String(error),
              }),
            )}\n\n`,
            abort.signal,
          ).catch(() => false);
        }
      } finally {
        res.off('close', onClose);
        abort.abort();
        if (!res.destroyed) res.end();
      }
    });
    app.get('/observer/conversations/messages', operator, async (req, res) =>
      res.json(await listConversationMessages(options.db, missionId, conversationQuery(req.query))),
    );
    app.get('/observer/conversations/events', operator, async (req, res) =>
      res.json(await conversationTimeline(options.db, missionId, conversationQuery(req.query))),
    );
    app.get('/observer/messages', operator, async (req, res) =>
      res.json(
        await messages(options.db, missionId, {
          agent: queryText(req.query, 'agent'),
          task: queryText(req.query, 'task'),
          message: queryText(req.query, 'message'),
          limit: req.query.limit === undefined ? undefined : Number(queryText(req.query, 'limit')),
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
            .status(
              error instanceof MeshError
                ? error.code === 'NOT_FOUND'
                  ? 404
                  : error.code.startsWith('INVALID_')
                    ? 400
                    : 500
                : 500,
            )
            .json({
              error: redact(error instanceof Error ? error.message : String(error)),
              ...(error instanceof MeshError ? { code: error.code } : {}),
            });
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
    await store.events({
      missionId,
      kind: 'daemon.ready',
      data: {
        url,
        repo,
        pid: process.pid,
        commandCapacity: {
          maxCommands: options.maxCommands ?? 2,
          maxQueuedCommands: options.maxQueuedCommands ?? 32,
        },
      },
    });
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
