/**
 * Config service implementation for the web dashboard backend.
 *
 * Implements the ConfigService interface by reading the six resolved
 * YAML config files from `.forjis/config/` and composing them into
 * a single ConfigResponse for the dashboard.
 */

import { join } from 'node:path';

import { readYamlFile } from '../state.js';
import type { ConfigService } from '@forjis/shared';
import type { ConfigResponse } from '@forjis/shared';

/** Raw shape of orgs.yaml as read from disk. */
interface OrgsFile {
  version: number;
  orgs: Array<{
    name: string;
    teams: Array<{
      name: string;
      roles: Array<{
        name: string;
        agent: string;
        skills: string[];
        hooks: { pre: string[]; validation: string[]; post: string[] };
        outcomes: string[];
        stage?: string;
        expertise?: string;
      }>;
    }>;
  }>;
}

/** Raw shape of constraints.yaml as read from disk. */
interface ConstraintsFile {
  mandatory: string;
  optional: string;
  pillars?: Array<{ path: string; content: string }>;
}

/** Raw shape of personas.yaml as read from disk. */
interface PersonasFile {
  dir: string;
  personas: Array<{
    name: string;
    description: string;
    tools: string[];
    model: string;
    content: string;
  }>;
}

/** Raw shape of tasks.yaml as read from disk. */
interface TasksFile {
  source?: string;
  path?: string;
  poll_interval?: string;
  max_concurrent?: number;
  auto_dependencies?: boolean;
}

/** Raw shape of health-check.yaml as read from disk. */
interface HealthCheckFile {
  interval: number;
  max_retries: number;
}

/** Raw shape of outcomes.yaml as read from disk. */
interface OutcomesFile {
  defaultAction: string;
  defaultMaxRetries: number;
  outcomes: Array<{
    name: string;
    metrics: Record<string, unknown>;
    rules: Array<{
      metric: string;
      operator: string;
      threshold: number;
      action: string;
    }>;
  }>;
}

/**
 * Implements ConfigService by reading resolved YAML config files.
 *
 * Reads all six config files on each call to ensure the response
 * reflects the latest resolved configuration.
 */
export class ConfigServiceImpl implements ConfigService {
  /**
   * Creates a ConfigServiceImpl.
   *
   * @param configDir - Absolute path to the `.forjis/config/` directory.
   */
  constructor(private readonly configDir: string) {}

  /**
   * Returns all resolved configuration data.
   *
   * Reads the six config YAML files in parallel and composes them
   * into a single ConfigResponse. Missing files are replaced with
   * sensible defaults (empty arrays, default values).
   *
   * @returns The full config response.
   */
  async getConfig(): Promise<ConfigResponse> {
    const [orgs, constraints, personas, tasks, healthCheck, tokenBudget, outcomes] =
      await Promise.all([
        readYamlFile<OrgsFile>(join(this.configDir, 'orgs.yaml')),
        readYamlFile<ConstraintsFile>(join(this.configDir, 'constraints.yaml')),
        readYamlFile<PersonasFile>(join(this.configDir, 'personas.yaml')),
        readYamlFile<TasksFile>(join(this.configDir, 'tasks.yaml')),
        readYamlFile<HealthCheckFile>(join(this.configDir, 'health-check.yaml')),
        readYamlFile<Record<string, unknown>>(join(this.configDir, 'token-budget.yaml')),
        readYamlFile<OutcomesFile>(join(this.configDir, 'outcomes.yaml')),
      ]);

    return {
      orgs: orgs ?? { version: 1, orgs: [] },
      constraints: {
        mandatory: constraints?.mandatory ?? '',
        optional: constraints?.optional ?? '',
        pillars: constraints?.pillars ?? [],
      },
      personas: {
        dir: personas?.dir ?? '',
        personas: personas?.personas ?? [],
      },
      tasks: tasks ?? {},
      healthCheck: healthCheck ?? { interval: 300, max_retries: 3 },
      tokenBudget: tokenBudget ?? {},
      outcomes: {
        defaultAction: outcomes?.defaultAction ?? 'halt',
        defaultMaxRetries: outcomes?.defaultMaxRetries ?? 2,
        outcomes: outcomes?.outcomes ?? [],
      },
    };
  }
}
