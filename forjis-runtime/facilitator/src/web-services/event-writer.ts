/**
 * Event log persistence module for the web dashboard.
 *
 * Manages per-role event files under .forjis/tasks/<taskId>/. Each role gets
 * its own file named `events-<canonicalSlug({org, team, role})>.jsonl` where
 * the slug is produced by the shared `canonicalSlug` helper. Orchestrator
 * events without an identity fall back to `events.jsonl`. Files use one JSON
 * object per line (JSONL); the dashboard polling endpoint filters by
 * timestamp. Role identities are passed as a structured `{org, team, role}`
 * triple — never as a free-form composite string — so the same logical role
 * always writes to exactly one file regardless of orchestrator prose.
 */

import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalSlug } from '@forjis/shared';
import type { RoleIdentity, TaskEvent } from '@forjis/shared';

/** @deprecated No longer enforced. Retained for backward compatibility. */
export const MAX_EVENT_LINES = 200;

/**
 * Appends an event to the appropriate event log file.
 *
 * When a role identity is provided, writes to
 * `events-<canonicalSlug({org,team,role})>.jsonl`. Otherwise falls back to
 * `events.jsonl` for orchestrator-level events. Serialises the event as a
 * single JSON line and appends it to the file.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param event - The event to append.
 * @param identity - Optional structured role identity for role-scoped file.
 */
export async function appendEvent(
  projectDir: string,
  taskId: string,
  event: TaskEvent,
  identity?: RoleIdentity,
): Promise<void> {
  const filePath = buildEventPath(projectDir, taskId, identity);
  const line = JSON.stringify(event) + '\n';

  await appendFile(filePath, line, 'utf-8');
}

/**
 * Reads events for a specific role from its dedicated file.
 *
 * Returns an empty array if the file does not exist. Skips blank lines and
 * lines that fail JSON parsing (defensive against partial writes).
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param identity - The structured role identity.
 * @returns Array of TaskEvent in chronological order.
 */
export async function readEventsForRole(
  projectDir: string,
  taskId: string,
  identity: RoleIdentity,
): Promise<TaskEvent[]> {
  return readEventsFromFile(buildEventPath(projectDir, taskId, identity));
}

/**
 * Reads all events from a task across all event files.
 *
 * Discovers all events-*.jsonl files in the task's queue directory, reads
 * each one, and returns all events merged and sorted by timestamp. Returns
 * an empty array if no event files exist.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @returns Array of TaskEvent sorted by timestamp.
 */
export async function readEvents(
  projectDir: string,
  taskId: string,
): Promise<TaskEvent[]> {
  const dir = join(projectDir, '.forjis', 'tasks', taskId);

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const eventFiles = files.filter((f) => f.startsWith('events') && f.endsWith('.jsonl'));
  const allEvents: TaskEvent[] = [];

  for (const file of eventFiles) {
    const events = await readEventsFromFile(join(dir, file));
    allEvents.push(...events);
  }

  allEvents.sort((a, b) => (a.timestamp > b.timestamp ? 1 : a.timestamp < b.timestamp ? -1 : 0));
  return allEvents;
}

/**
 * Reads events for a specific role since a given timestamp.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param identity - The structured role identity.
 * @param since - ISO 8601 timestamp threshold.
 * @returns Array of matching TaskEvent in chronological order.
 */
export async function readEventsForRoleSince(
  projectDir: string,
  taskId: string,
  identity: RoleIdentity,
  since: string,
): Promise<TaskEvent[]> {
  const all = await readEventsForRole(projectDir, taskId, identity);
  return all.filter((event) => event.timestamp > since);
}

/**
 * Reads events from all files since a given timestamp.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param since - ISO 8601 timestamp threshold.
 * @returns Array of matching TaskEvent sorted by timestamp.
 */
export async function readEventsSince(
  projectDir: string,
  taskId: string,
  since: string,
): Promise<TaskEvent[]> {
  const all = await readEvents(projectDir, taskId);
  return all.filter((event) => event.timestamp > since);
}

/**
 * Reads and parses events from a single JSONL file.
 *
 * @param filePath - Absolute path to the JSONL file.
 * @returns Array of TaskEvent in file order.
 */
async function readEventsFromFile(filePath: string): Promise<TaskEvent[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter((l) => l.length > 0);
  const events: TaskEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TaskEvent);
    } catch {
      // Skip malformed lines defensively
    }
  }

  return events;
}

/**
 * Builds the file path for a task's event log file.
 *
 * When an identity triple is provided, returns the role-specific path:
 * `.forjis/tasks/<taskId>/events-<canonicalSlug({org,team,role})>.jsonl`.
 * Otherwise returns the fallback `.forjis/tasks/<taskId>/events.jsonl` used
 * by orchestrator-level events that are not tied to a single role.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param identity - Optional structured role identity.
 * @returns The absolute file path for the events log.
 */
export function buildEventPath(
  projectDir: string,
  taskId: string,
  identity?: RoleIdentity,
): string {
  const dir = join(projectDir, '.forjis', 'tasks', taskId);
  if (identity) {
    return join(dir, `events-${canonicalSlug(identity)}.jsonl`);
  }
  return join(dir, 'events.jsonl');
}
