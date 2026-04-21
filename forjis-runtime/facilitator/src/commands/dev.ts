/**
 * `forjis dev` command implementation.
 *
 * Boots the full inspector-enabled dev session in a single invocation:
 * generates a session token, stands up the HTTP + WebSocket server with
 * the Inspector transport wired, spawns the user's dev-server
 * subprocess, prints a scannable session URL plus a QR code, optionally
 * launches a public tunnel (`cloudflared` → `ngrok` probe), and
 * installs signal handlers that tear every resource down cleanly on
 * `SIGINT` / `SIGTERM`.
 *
 * This command never writes to `.forjis/config/` (that remains the
 * resolver's job) and never composes prompts — the clarifier persona is
 * loaded from disk and forwarded as-is via
 * {@link InspectorClarifierRunner}. All business logic around
 * option-resolution (CLI → `build.forjis dev.<field>` → literal default)
 * lives here; every dev-server subprocess concern is delegated to
 * {@link ./dev-server-process.js} and every tunnel concern to
 * {@link ./tunnel-launcher.js}.
 */

import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Server } from 'node:http';

import qrcodeTerminal from 'qrcode-terminal';

import { resolve as resolveConfig } from '@forjis/resolver';
import type { ConfigResult, DevConfig } from '@forjis/resolver';

import { readEngineFromConfig } from '../config-utils.js';
import { loadEngine } from '../engine.js';
import { loadClarifierAgent } from '../inspector-agent-loader.js';
import type { ClarifierAgent } from '../inspector-agent-loader.js';
import { InspectorClarifierRunner } from '../inspector-clarifier-runner.js';
import type { ClarifierPersonaLoader } from '../inspector-clarifier-runner.js';
import {
  SessionTokenRegistry,
  generateSessionToken,
} from '../session-token.js';
import { TaskQueue } from '../task-queue.js';
import { TokenTracker } from '../token-tracker.js';
import type { WorkerStateRef } from '../web-services/runtime-service.js';
import { InspectorServiceImpl } from '../web-services/inspector-service.js';
import { wireInspectorMessagePump } from '../web-services/inspector-message-pump.js';
import {
  spawnDevServer,
  type DevServerProcess,
} from './dev-server-process.js';
import { launchTunnel, type Tunnel } from './tunnel-launcher.js';

/** Default port used when neither CLI flag nor `build.forjis` supplies one. */
const DEFAULT_PORT = 4242;

/** Default shell command spawned when no `dev.command` is configured. */
const DEFAULT_DEV_COMMAND = 'npm run dev';

/** Default bind host. */
const DEFAULT_BIND_HOST = '0.0.0.0';

/** Host used when no LAN IPv4 is discoverable. */
const LOOPBACK_HOST = '127.0.0.1';

/** Grace period for tearing down the dev-server subprocess. */
const DEV_SERVER_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Options accepted by {@link devCommand}.
 *
 * Every field is optional at the CLI boundary; precedence is resolved
 * inside the function per design §D8: `options.<field>` → `dev.<field>`
 * from `build.forjis` → literal default.
 */
export interface DevCommandOptions {
  /**
   * HTTP + WebSocket listen port. Precedence:
   *   flag → `build.forjis dev.port` → {@link DEFAULT_PORT}.
   */
  port?: number;
  /**
   * Host for both binding and URL printing. When omitted, the server
   * binds `0.0.0.0` and the printed URL uses the first non-internal
   * IPv4 discovered via `os.networkInterfaces()`.
   */
  host?: string;
  /**
   * Shell command for the user's dev-server subprocess. Precedence:
   *   flag → `build.forjis dev.command` → `"npm run dev"`.
   */
  devServerCmd?: string;
  /**
   * Working directory for the dev-server subprocess. Precedence:
   *   flag → `build.forjis dev.cwd` → `projectDir`.
   */
  devServerCwd?: string;
  /** When `true`, probe `cloudflared` / `ngrok` and print a public URL + QR. */
  tunnel?: boolean;
}

/** Resolved option bag used internally after precedence evaluation. */
interface ResolvedDevOptions {
  port: number;
  bindHost: string;
  printedHost: string;
  devServerCmd: string;
  devServerCwd: string;
  tunnel: boolean;
}

/** Bundle of live resources the shutdown sequence tears down. */
interface ShutdownContext {
  token: string;
  registry: SessionTokenRegistry;
  devChild: DevServerProcess | null;
  httpServer: Server | null;
  clarifierRunner: InspectorClarifierRunner | null;
  tunnelHandle: Tunnel | null;
  idleResolver: () => void;
}

/** Discriminated reason for the shutdown invocation. */
type ShutdownReason = 'signal' | 'child-exit' | 'startup-error';

/**
 * Select a routable LAN IPv4 address, falling back to loopback.
 *
 * Walks `os.networkInterfaces()` and returns the first non-internal
 * IPv4 address. When none is available, returns {@link LOOPBACK_HOST} so
 * the printed URL is still well-formed.
 *
 * @returns A dotted-quad IPv4 string.
 */
function pickLanIPv4(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return LOOPBACK_HOST;
}

/**
 * Apply the precedence chain to option inputs.
 *
 * @param opts - Options supplied by the CLI.
 * @param devConfig - Optional `dev` block from the resolved build file.
 * @returns Fully resolved option bag with defaults applied.
 */
function resolveOptions(
  opts: DevCommandOptions,
  devConfig: DevConfig | null,
): ResolvedDevOptions {
  const port = opts.port ?? devConfig?.port ?? DEFAULT_PORT;
  const explicitHost = opts.host ?? devConfig?.host;
  const bindHost = explicitHost ?? DEFAULT_BIND_HOST;
  const printedHost = explicitHost ?? pickLanIPv4();
  const devServerCmd =
    opts.devServerCmd ?? devConfig?.command ?? DEFAULT_DEV_COMMAND;
  const devServerCwd = opts.devServerCwd ?? devConfig?.cwd ?? '';
  return {
    port,
    bindHost,
    printedHost,
    devServerCmd,
    devServerCwd,
    tunnel: opts.tunnel === true,
  };
}

/**
 * Build the Inspector primitives (service, transport, message pump).
 *
 * @param projectDir - Target project root used for staging paths.
 * @param registry - Session-token registry consulted by the transport.
 * @returns The constructed Inspector service and transport pair.
 */
async function buildInspectorPrimitives(
  projectDir: string,
  registry: SessionTokenRegistry,
): Promise<{
  service: InspectorServiceImpl;
  transport: import('@forjis/shared').InspectorTransport;
  stagingRoot: string;
}> {
  const stagingRoot = join(projectDir, '.forjis', 'inspector');
  const service = new InspectorServiceImpl({ projectDir, stagingRoot });
  const webModule = await import('@forjis/web');
  const transport = webModule.createInspectorWebSocketServer({
    tokenRegistry: registry,
  });
  wireInspectorMessagePump(transport, service);
  return { service, transport, stagingRoot };
}

/**
 * Construct a {@link InspectorClarifierRunner} and start its
 * subscriptions.
 *
 * @param bundle - Pre-built Inspector service + transport pair.
 * @param projectDir - Target project root.
 * @param configDir - Resolved config directory from the resolver.
 * @param buildFilePath - Path to the `build.forjis` file.
 * @returns The started runner.
 */
async function startClarifierRunner(
  bundle: {
    service: InspectorServiceImpl;
    transport: import('@forjis/shared').InspectorTransport;
    stagingRoot: string;
  },
  projectDir: string,
  configDir: string,
  buildFilePath: string,
): Promise<InspectorClarifierRunner> {
  const engineName = await readEngineFromConfig(buildFilePath);
  const engine = await loadEngine(engineName);
  const tokenTracker = new TokenTracker();
  await tokenTracker.load(projectDir);

  const personaLoader: ClarifierPersonaLoader = (dir: string): ClarifierAgent =>
    loadClarifierAgent(undefined, dir);

  const runner = new InspectorClarifierRunner({
    engine,
    service: bundle.service,
    transport: bundle.transport,
    tokenTracker,
    personaLoader,
    projectDir,
    configDir,
    stagingRoot: bundle.stagingRoot,
    tokenBudget: null,
  });
  runner.start();
  return runner;
}

/** Options passed to {@link startWebServer}. */
interface StartWebServerArgs {
  projectDir: string;
  configResult: ConfigResult;
  resolved: ResolvedDevOptions;
  registry: SessionTokenRegistry;
  transport: import('@forjis/shared').InspectorTransport;
}

/**
 * Instantiate every web service the dashboard expects and call
 * `createWebServer` with the Inspector transport wired.
 *
 * The service-construction block mirrors `run.ts::startWebServer`
 * verbatim so the dev command exposes the same REST surface.
 *
 * @param args - Bundle of inputs.
 * @returns The started HTTP server.
 */
async function startWebServer(args: StartWebServerArgs): Promise<Server> {
  const { projectDir, configResult, resolved, registry, transport } = args;
  const { TaskServiceImpl } = await import('../web-services/task-service.js');
  const { PlanServiceImpl } = await import('../web-services/plan-service.js');
  const { EventServiceImpl } = await import('../web-services/event-service.js');
  const { ResourceServiceImpl } = await import(
    '../web-services/resource-service.js'
  );
  const { TokenUsageServiceImpl } = await import(
    '../web-services/token-usage-service.js'
  );
  const { FileServiceImpl } = await import('../web-services/file-service.js');
  const { PluginFileServiceImpl } = await import(
    '../web-services/plugin-file-service.js'
  );
  const { TaskFileServiceImpl } = await import(
    '../web-services/task-file-service.js'
  );
  const { ManifestServiceImpl } = await import(
    '../web-services/manifest-service.js'
  );
  const { ConfigServiceImpl } = await import(
    '../web-services/config-service.js'
  );
  const { RuntimeServiceImpl } = await import(
    '../web-services/runtime-service.js'
  );
  const { createWebServer } = await import('@forjis/web');

  const queue = new TaskQueue(projectDir, null);
  const workerState: WorkerStateRef = { busy: 0, max: 1 };
  const tracker = new TokenTracker();
  await tracker.load(projectDir);

  const require = createRequire(import.meta.url);
  const webPkgPath = dirname(require.resolve('@forjis/web/package.json'));
  const clientDir = join(webPkgPath, 'client', 'dist');

  return createWebServer({
    port: resolved.port,
    host: resolved.bindHost,
    token: undefined,
    clientDir,
    projectDir,
    taskService: new TaskServiceImpl(queue, projectDir),
    planService: new PlanServiceImpl(projectDir),
    eventService: new EventServiceImpl(projectDir),
    resourceService: new ResourceServiceImpl(
      configResult.runtimeConfig,
      configResult.registry,
    ),
    tokenUsageService: new TokenUsageServiceImpl(tracker, null),
    fileService: new FileServiceImpl(projectDir),
    pluginFileService: new PluginFileServiceImpl(
      configResult.registry.getPluginRoots(),
    ),
    taskFileService: new TaskFileServiceImpl(projectDir),
    manifestService: new ManifestServiceImpl(projectDir),
    configService: new ConfigServiceImpl(configResult.configDir),
    runtimeService: new RuntimeServiceImpl('dev', workerState, tracker, null),
    inspector: { transport, tokenRegistry: registry },
  });
}

/**
 * Close an HTTP server and resolve once the server has fully stopped
 * accepting connections.
 *
 * @param server - Running HTTP server instance.
 * @returns A promise resolving when `close()` completes.
 */
function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((err) => {
      if (err) rejectPromise(err);
      else resolvePromise();
    });
  });
}

/**
 * Render a QR code for `url` and forward each ASCII line to `log`.
 *
 * @param url - URL to encode.
 * @param log - Output sink for the rendered QR lines.
 */
function printQrCode(url: string, log: (line: string) => void): void {
  qrcodeTerminal.generate(url, { small: true }, (qr) => {
    log(qr);
  });
}

/**
 * Print the inspector session banner (URL + QR) to stdout.
 *
 * @param url - Fully-formed inspector session URL.
 */
function printSessionBanner(url: string): void {
  console.log(`[dev] inspector session ready: ${url}`);
  printQrCode(url, (line) => console.log(line));
}

/**
 * Idempotent shutdown driver.
 *
 * Runs exactly once; subsequent invocations return the same in-flight
 * promise. Teardown order matches design §D4 with the revised step in
 * the design.md Risks section — the registry is revoked first so any
 * in-flight upgrade racing the close is refused synchronously.
 *
 * @param reason - Why the shutdown was triggered.
 * @param ctx - Bundle of live resources to tear down.
 * @param state - Shared mutable flag bag used to enforce idempotency.
 * @returns A promise that resolves once teardown finishes (but note
 *   the function also calls `process.exit`).
 */
async function runShutdown(
  reason: ShutdownReason,
  ctx: ShutdownContext,
  state: { shuttingDown: boolean },
): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  console.log(`[dev] shutting down (reason: ${reason})...`);

  ctx.registry.revoke(ctx.token);

  if (ctx.devChild !== null) {
    try {
      await ctx.devChild.terminate(DEV_SERVER_SHUTDOWN_GRACE_MS);
    } catch (err) {
      console.warn(
        `[dev] dev-server termination failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (ctx.httpServer !== null) {
    try {
      await closeHttpServer(ctx.httpServer);
    } catch (err) {
      console.warn(
        `[dev] http server close failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (ctx.tunnelHandle !== null) {
    try {
      await ctx.tunnelHandle.close();
    } catch (err) {
      console.warn(
        `[dev] tunnel close failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (ctx.clarifierRunner !== null) {
    try {
      await ctx.clarifierRunner.stop();
    } catch (err) {
      console.warn(
        `[dev] clarifier runner stop failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  ctx.idleResolver();
  if (process.env.FORJIS_DEV_SKIP_EXIT !== '1') {
    process.exit(reason === 'startup-error' ? 1 : 0);
  }
}

/**
 * Install `SIGINT` and `SIGTERM` handlers that delegate to
 * {@link runShutdown}.
 *
 * @param ctx - Shared shutdown context.
 * @param state - Shared idempotency flag bag.
 */
function installSignalHandlers(
  ctx: ShutdownContext,
  state: { shuttingDown: boolean },
): void {
  const onSignal = (): void => {
    void runShutdown('signal', ctx, state);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

/**
 * Boot the inspector dev session and block until shutdown completes.
 *
 * @param projectDir - Absolute project root.
 * @param buildFilePath - Absolute path to `build.forjis`.
 * @param options - CLI-derived options; see {@link DevCommandOptions}.
 * @returns A promise that resolves once the shutdown sequence finishes.
 * @throws {Error} When startup fails (port in use, tunnel tool missing,
 *   build file invalid, etc.). The shutdown sequence runs before the
 *   rejection propagates so no orphaned subprocess is left behind.
 */
export async function devCommand(
  projectDir: string,
  buildFilePath: string,
  options: DevCommandOptions,
): Promise<void> {
  const configResult = await resolveConfig(buildFilePath, { projectDir });
  const resolved = resolveOptions(options, configResult.runtimeConfig.dev);
  const effectiveCwd =
    resolved.devServerCwd.length > 0 ? resolved.devServerCwd : projectDir;

  const token = generateSessionToken();
  const registry = new SessionTokenRegistry();
  registry.register(token, {
    label: 'forjis dev session',
    createdAt: new Date().toISOString(),
  });

  const state = { shuttingDown: false };
  let idleResolver: () => void = () => {
    /* replaced below */
  };
  const idlePromise = new Promise<void>((resolvePromise) => {
    idleResolver = resolvePromise;
  });

  const ctx: ShutdownContext = {
    token,
    registry,
    devChild: null,
    httpServer: null,
    clarifierRunner: null,
    tunnelHandle: null,
    idleResolver,
  };
  installSignalHandlers(ctx, state);

  try {
    const bundle = await buildInspectorPrimitives(projectDir, registry);
    ctx.clarifierRunner = await startClarifierRunner(
      bundle,
      projectDir,
      configResult.configDir,
      buildFilePath,
    );

    ctx.httpServer = await startWebServer({
      projectDir,
      configResult,
      resolved,
      registry,
      transport: bundle.transport,
    });

    ctx.devChild = spawnDevServer({
      command: resolved.devServerCmd,
      cwd: effectiveCwd,
      onLine: (line) => console.log(line),
    });
    ctx.devChild.exited
      .then(() => {
        if (!state.shuttingDown) {
          void runShutdown('child-exit', ctx, state);
        }
      })
      .catch(() => {
        /* handled by terminate path */
      });

    const sessionUrl = `http://${resolved.printedHost}:${resolved.port}/inspector?t=${token}`;
    printSessionBanner(sessionUrl);

    if (resolved.tunnel) {
      ctx.tunnelHandle = await launchTunnel({
        host: resolved.bindHost,
        port: resolved.port,
        logger: (line) => console.log(`[tunnel] ${line}`),
      });
      const publicUrl = `${ctx.tunnelHandle.publicUrl}/inspector?t=${token}`;
      console.log(`[dev] public tunnel: ${publicUrl}`);
      printQrCode(publicUrl, (line) => console.log(line));
    }
  } catch (err) {
    await runShutdown('startup-error', ctx, state);
    throw err;
  }

  await idlePromise;
}
