#!/usr/bin/env node

/**
 * CLI entry point for the forjis command.
 *
 * Unified CLI format:
 *   forjis <resource> <action> <flags> <params>
 *
 * Resources & actions:
 *   forjis run                          -- run the pipeline (default)
 *   forjis dev [flags]                  -- start an inspector dev session
 *   forjis init                         -- scaffold build.forjis
 *   forjis validate                     -- validate build file
 *   forjis status                       -- show queue state
 *   forjis stop [task-id]               -- stop running task(s)
 *   forjis assess <task-id>             -- re-run assessment
 *   forjis version                      -- show component versions
 *   forjis registry list                -- list resources
 *   forjis registry add <url|path>      -- add repository
 *   forjis task create <desc> [-i]      -- generate task file from description
 *   forjis task activate [--force]      -- activate underscore-prefixed tasks
 *   forjis task clean [--force]         -- remove runtime state
 *   forjis task remove [--force]        -- remove non-underscore tasks + clean
 *   forjis task nuke [--force]          -- remove all tasks + clean
 *   forjis persona create <desc> [-i]   -- generate persona from description
 *   forjis persona run [names]          -- run persona agents
 *   forjis strategist run [--loop N]    -- run autonomous code scanner
 *
 * Flags:
 *   -f <path>      -- build file path (default: ./build.forjis)
 *   -t <desc>      -- inline task description
 *   --dry-run      -- resolve without executing
 *   --watch        -- continuous polling mode
 *   --no-assess    -- skip outcome assessment
 *   --web          -- start web dashboard server
 *   --port <n>     -- web server port (default: 4242)
 *   --host <addr>  -- web server bind address (default: 127.0.0.1)
 *   --web-token [v] -- enable auth token (auto-generate if no value given)
 *   --dev-cmd <cmd>  -- shell command for the user's dev server (forjis dev)
 *   --dev-cwd <path> -- working directory for the dev server (forjis dev)
 *   --tunnel       -- launch a public tunnel via cloudflared/ngrok (forjis dev)
 *   -i             -- interactive mode (task create / persona create)
 *   --force        -- skip confirmation prompt
 *   --help         -- show usage
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
  assessCommand,
  contextRefreshCommand,
  devCommand,
  initCommand,
  personaGenerateCommand,
  personaRunCommand,
  registryAddCommand,
  strategistRunCommand,
  registryListCommand,
  runCommand,
  statusCommand,
  stopCommand,
  taskCreateCommand,
  tasksActivateCommand,
  tasksCleanCommand,
  tasksRemoveCommand,
  tasksNukeCommand,
  validateCommand,
  versionCommand,
} from '@forjis/facilitator';

/** Parsed CLI arguments. */
interface ParsedArgs {
  command: string | null;
  subCommand: string | null;
  buildFilePath: string;
  inlineTask: string | null;
  dryRun: boolean;
  watch: boolean;
  noAssess: boolean;
  interactive: boolean;
  web: boolean;
  port: number;
  /** True when `--port` was supplied explicitly; distinguishes "unset" from the default. */
  portExplicit: boolean;
  host: string;
  /** True when `--host` was supplied explicitly; distinguishes "unset" from the default. */
  hostExplicit: boolean;
  webToken: string | null;
  /** Shell command for the `forjis dev` subprocess; null when not supplied. */
  devCmd: string | null;
  /** Working directory for the `forjis dev` subprocess; null when not supplied. */
  devCwd: string | null;
  /** Whether `forjis dev --tunnel` should spawn a tunnel tool. */
  tunnel: boolean;
  force: boolean;
  help: boolean;
  loopCount: number | null;
  positional: string[];
}

/**
 * Main entry point. Parses arguments and routes to command handlers.
 *
 * Exits with code 0 on success, 1 on error.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  printVersions();

  if (args.help) {
    printHelp(args.command);
    return;
  }

  if (args.positional.includes('--version')) {
    versionCommand();
    return;
  }

  try {
    await routeCommand(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/** Parses raw CLI arguments into a structured format. */
function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: null,
    subCommand: null,
    buildFilePath: resolve('build.forjis'),
    inlineTask: null,
    dryRun: false,
    watch: false,
    noAssess: false,
    interactive: false,
    web: false,
    port: 4242,
    portExplicit: false,
    host: '127.0.0.1',
    hostExplicit: false,
    webToken: null,
    devCmd: null,
    devCwd: null,
    tunnel: false,
    force: false,
    help: false,
    loopCount: null,
    positional: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '-f' && i + 1 < argv.length) {
      result.buildFilePath = resolve(argv[i + 1]);
      i += 2;
      continue;
    }

    if (arg === '-t' && i + 1 < argv.length) {
      result.inlineTask = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--dry-run') {
      result.dryRun = true;
      i++;
      continue;
    }

    if (arg === '--watch') {
      result.watch = true;
      i++;
      continue;
    }

    if (arg === '--no-assess') {
      result.noAssess = true;
      i++;
      continue;
    }

    if (arg === '-i') {
      result.interactive = true;
      i++;
      continue;
    }

    if (arg === '--force') {
      result.force = true;
      i++;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      i++;
      continue;
    }

    if (arg === '--web') {
      result.web = true;
      i++;
      continue;
    }

    if (arg === '--port' && i + 1 < argv.length) {
      const port = parseInt(argv[i + 1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('--port requires an integer between 1 and 65535');
      }
      result.port = port;
      result.portExplicit = true;
      i += 2;
      continue;
    }

    if (arg === '--host' && i + 1 < argv.length) {
      result.host = argv[i + 1];
      result.hostExplicit = true;
      i += 2;
      continue;
    }

    if (arg === '--dev-cmd' && i + 1 < argv.length) {
      result.devCmd = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--dev-cwd' && i + 1 < argv.length) {
      result.devCwd = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--tunnel') {
      result.tunnel = true;
      i++;
      continue;
    }

    if (arg === '--web-token') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result.webToken = next;
        i += 2;
      } else {
        result.webToken = randomUUID();
        i++;
      }
      continue;
    }

    if (arg === '--loop') {
      if (i + 1 >= argv.length) {
        throw new Error('--loop requires a positive integer');
      }
      const count = parseInt(argv[i + 1], 10);
      if (isNaN(count) || count < 1) {
        throw new Error('--loop requires a positive integer');
      }
      result.loopCount = count;
      i += 2;
      continue;
    }

    result.positional.push(arg);
    i++;
  }

  if (result.positional.length > 0) {
    result.command = result.positional[0];
  }
  if (result.positional.length > 1) {
    result.subCommand = result.positional[1];
  }

  return result;
}

/** Routes parsed arguments to the appropriate command handler. */
async function routeCommand(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();

  switch (args.command) {
    case 'init':
      await initCommand(cwd);
      break;

    case 'validate':
      await validateCommand(args.buildFilePath);
      break;

    case 'status':
      await statusCommand(cwd);
      break;

    case 'stop':
      await stopCommand(cwd, args.subCommand ?? undefined);
      break;

    case 'assess': {
      const taskId = args.subCommand;
      if (!taskId) {
        throw new Error('Usage: forjis assess <task-id>');
      }
      await assessCommand(cwd, taskId, args.buildFilePath);
      break;
    }

    case 'registry':
      await routeRegistry(args);
      break;

    case 'persona':
      await routePersona(args);
      break;

    case 'strategist':
      await routeStrategist(args);
      break;

    case 'task':
      await routeTask(args);
      break;

    case 'context':
      await routeContext(args);
      break;

    case 'version':
      versionCommand();
      break;

    case 'run':
      await runCommand({
        buildFilePath: args.buildFilePath,
        inlineTask: args.inlineTask,
        dryRun: args.dryRun,
        watch: args.watch,
        noAssess: args.noAssess,
        web: args.web,
        port: args.port,
        host: args.host,
        webToken: args.webToken,
        projectDir: cwd,
      });
      break;

    case 'dev':
      await devCommand(cwd, args.buildFilePath, {
        port: args.portExplicit ? args.port : undefined,
        host: args.hostExplicit ? args.host : undefined,
        devServerCmd: args.devCmd ?? undefined,
        devServerCwd: args.devCwd ?? undefined,
        tunnel: args.tunnel,
      });
      break;

    default:
      if (args.command !== null) {
        console.error(`Unknown command "${args.command}". Run "forjis --help" for available commands.`);
        process.exit(1);
      }
      await runCommand({
        buildFilePath: args.buildFilePath,
        inlineTask: args.inlineTask,
        dryRun: args.dryRun,
        watch: args.watch,
        noAssess: args.noAssess,
        web: args.web,
        port: args.port,
        host: args.host,
        webToken: args.webToken,
        projectDir: cwd,
      });
      break;
  }
}

/** Routes registry subcommands. */
async function routeRegistry(args: ParsedArgs): Promise<void> {
  switch (args.subCommand) {
    case 'list':
      await registryListCommand(args.buildFilePath);
      break;

    case 'add': {
      const urlOrPath = args.positional[2];
      if (!urlOrPath) {
        throw new Error('Usage: forjis registry add <url|path>');
      }
      await registryAddCommand(args.buildFilePath, urlOrPath);
      break;
    }

    default:
      throw new Error('Usage: forjis registry list|add <url|path>');
  }
}

/** Routes persona subcommands (create, run). */
async function routePersona(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();

  switch (args.subCommand) {
    case 'create': {
      const description = args.positional.slice(2).join(' ');
      if (!description) {
        throw new Error('Usage: forjis persona create <description> [-i]');
      }
      await personaGenerateCommand(cwd, args.buildFilePath, description, args.interactive);
      break;
    }

    case 'run': {
      const names = args.positional[2] ?? null;
      await personaRunCommand(cwd, args.buildFilePath, names);
      break;
    }

    default:
      throw new Error('Usage: forjis persona create <description> [-i] | run [names]');
  }
}

/**
 * Routes strategist subcommands (run).
 *
 * @param args - The parsed CLI arguments.
 * @throws {Error} If the subcommand is not recognized.
 */
async function routeStrategist(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();

  switch (args.subCommand) {
    case 'run':
      await strategistRunCommand(cwd, args.buildFilePath, {
        loopCount: args.loopCount,
      });
      break;

    default:
      throw new Error('Usage: forjis strategist run [--loop <count>]');
  }
}

/**
 * Routes context subcommands (refresh).
 *
 * @param args - The parsed CLI arguments.
 */
async function routeContext(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();

  switch (args.subCommand) {
    case 'refresh':
      await contextRefreshCommand(cwd, args.buildFilePath);
      break;

    default:
      throw new Error('Usage: forjis context refresh');
  }
}

/** Routes task subcommands (create, activate, clean, remove, nuke). */
async function routeTask(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();

  switch (args.subCommand) {
    case 'create': {
      const description = args.positional.slice(2).join(' ') || null;
      if (!description) {
        throw new Error('Usage: forjis task create <description> [-i]');
      }
      await taskCreateCommand(cwd, args.buildFilePath, description, args.interactive);
      break;
    }

    case 'activate':
      await tasksActivateCommand(cwd, args.buildFilePath, args.force);
      break;

    case 'clean':
      await tasksCleanCommand(cwd, args.force);
      break;

    case 'remove':
      await tasksRemoveCommand(cwd, args.buildFilePath, args.force);
      break;

    case 'nuke':
      await tasksNukeCommand(cwd, args.buildFilePath, args.force);
      break;

    default:
      throw new Error('Usage: forjis task create <description> [-i] | activate | clean | remove | nuke [--force]');
  }
}

/** Prints the version of each component on startup. */
function printVersions(): void {
  const require = createRequire(import.meta.url);
  const components = [
    '@forjis/cli',
    '@forjis/facilitator',
    '@forjis/web',
    '@forjis/orchestrator',
  ] as const;

  const versions = components.map((name) => {
    try {
      const pkg = require(`${name}/package.json`) as { version: string };
      return `${name}@${pkg.version}`;
    } catch {
      return `${name}@unknown`;
    }
  });

  console.log(`forjis ${versions.join(' | ')}`);
}

/** Routes help output based on the command. */
function printHelp(command: string | null): void {
  switch (command) {
    case 'task':
      printTaskHelp();
      break;
    case 'persona':
      printPersonaHelp();
      break;
    case 'registry':
      printRegistryHelp();
      break;
    case 'strategist':
      printStrategistHelp();
      break;
    case 'dev':
      printDevHelp();
      break;
    case 'context':
      printContextHelp();
      break;
    default:
      printUsage();
      break;
  }
}

/** Prints help for the task subcommand. */
function printTaskHelp(): void {
  console.log(`
Usage: forjis task <action> [flags]

Actions:
  create <description> [-i]   Generate a task file from a description
  activate [--force]          Activate underscore-prefixed task files
  clean [--force]             Remove .forjis/ and openspec/ runtime state
  remove [--force]            Remove non-underscore task files + clean
  nuke [--force]              Remove ALL task files + clean

Flags:
  -i                          Interactive mode (task create only)
  --force                     Skip confirmation prompt
  --help                      Show this help message
`);
}

/** Prints help for the persona subcommand. */
function printPersonaHelp(): void {
  console.log(`
Usage: forjis persona <action> [flags]

Actions:
  create <description> [-i]   Generate a persona from a description
  run [names]                 Run persona agents (all or comma-separated)

Flags:
  -i                          Interactive mode (persona create only)
  --help                      Show this help message
`);
}

/** Prints help for the registry subcommand. */
function printRegistryHelp(): void {
  console.log(`
Usage: forjis registry <action> [params]

Actions:
  list                        List available resources
  add <url|path>              Add a repository to the build file

Flags:
  --help                      Show this help message
`);
}

/** Prints help for the dev subcommand. */
function printDevHelp(): void {
  console.log(`
Usage: forjis dev [flags]

Starts an inspector dev session: HTTP dashboard + WebSocket endpoint +
user dev-server subprocess. Prints a scannable session URL and QR code
at startup; tears everything down cleanly on Ctrl-C (SIGINT) or SIGTERM.

Flags:
  --port <number>             HTTP / WebSocket listen port (default: 4242)
  --host <address>            Bind + printed host (default: LAN IPv4 or 127.0.0.1)
  --dev-cmd <command>         Shell command for the user's dev server
                              (default: "npm run dev" or build.forjis dev.command)
  --dev-cwd <path>            Working directory for the dev server
                              (default: project root or build.forjis dev.cwd)
  --tunnel                    Launch a public tunnel via cloudflared/ngrok
                              (detects whichever is on PATH first)
  --help                      Show this help message
`);
}

/** Prints help for the context subcommand. */
function printContextHelp(): void {
  console.log(`
Usage: forjis context <action> [flags]

Actions:
  refresh                     Refresh the file-level context index

Flags:
  -f <path>                   Build file path (default: ./build.forjis)
  --help                      Show this help message
`);
}

/** Prints help for the strategist subcommand. */
function printStrategistHelp(): void {
  console.log(`
Usage: forjis strategist <action> [flags]

Actions:
  run [--loop N]              Run autonomous code scanner

Flags:
  --loop <count>              Number of scan-execute cycles
  --help                      Show this help message
`);
}

/** Prints usage information. */
function printUsage(): void {
  console.log(`
Usage: forjis <resource> <action> [flags] [params]

Framework commands (no resource):
  run                              Run the pipeline (default)
  dev                              Start an inspector dev session (HTTP + WS + dev server)
  init                             Scaffold a new build.forjis
  validate                         Parse and validate the build file
  status                           Show queue state
  stop [task-id]                   Stop running task(s) and kill Claude processes
  assess <task-id>                 Re-run outcome assessment
  version                          Show component versions

Resource commands:
  task create <description> [-i]   Generate a task file from a description
  task activate [--force]          Activate underscore-prefixed task files
  task clean [--force]             Remove .forjis/ and openspec/ runtime state
  task remove [--force]            Remove non-underscore task files + clean
  task nuke [--force]              Remove ALL task files + clean
  persona create <desc> [-i]       Generate a persona from a description
  persona run [names]              Run persona agents (all or comma-separated)
  strategist run [--loop N]        Run autonomous code scanner
  context refresh                  Refresh the file-level context index
  registry list                    List available resources
  registry add <url|path>          Add a repository to the build file

Flags:
  -f <path>              Build file path (default: ./build.forjis)
  -t <description>       Inline task description
  --dry-run              Resolve without executing
  --watch                Continuous polling mode
  --no-assess            Skip outcome assessment
  --web                  Start web dashboard server
  --port <number>        Web server port (default: 4242)
  --host <address>       Web server bind address (default: 127.0.0.1)
  --web-token [value]    Enable auth token (auto-generate if no value)
  --dev-cmd <command>    Shell command for the dev server (forjis dev)
  --dev-cwd <path>       Working directory for the dev server (forjis dev)
  --tunnel               Launch a public tunnel via cloudflared/ngrok (forjis dev)
  -i                     Interactive mode (task create / persona create)
  --force                Skip confirmation prompt
  --help                 Show this help message
`);
}

main();
