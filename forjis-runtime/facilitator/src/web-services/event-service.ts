/**
 * Event service implementation for the web dashboard backend.
 *
 * Implements the EventService interface by reading per-role event files
 * from disk using the event-writer module's read functions. Provides
 * both unfiltered and role-scoped event retrieval for the API layer's
 * polling and SSE endpoints.
 */

import type { EventService, RoleIdentity } from '@forjis/shared';
import type { TaskEvent } from '../types.js';
import { readEvents, readEventsSince, readEventsForRole, readEventsForRoleSince } from './event-writer.js';

/**
 * Implements EventService by reading per-role event files from disk.
 *
 * Uses the readEvents, readEventsForRole, and related functions from
 * event-writer.ts for all file I/O. Each call reads fresh data from disk.
 */
export class EventServiceImpl implements EventService {
  /**
   * Creates an EventServiceImpl.
   *
   * @param projectDir - The root directory of the target project.
   */
  constructor(private readonly projectDir: string) {}

  /**
   * Returns all events for a task, optionally filtered by timestamp.
   *
   * Reads all event files and merges by timestamp.
   *
   * @param taskId - The task identifier.
   * @param since - Optional ISO timestamp; only events after this time are returned.
   * @returns Array of TaskEvent in chronological order.
   */
  async getEvents(taskId: string, since?: string): Promise<TaskEvent[]> {
    if (since !== undefined) {
      return readEventsSince(this.projectDir, taskId, since);
    }
    return readEvents(this.projectDir, taskId);
  }

  /**
   * Returns events since a given timestamp, for SSE polling.
   *
   * @param taskId - The task identifier.
   * @param since - ISO timestamp of the last known event.
   * @returns Array of new TaskEvent in chronological order.
   */
  async getEventsSince(taskId: string, since: string): Promise<TaskEvent[]> {
    return readEventsSince(this.projectDir, taskId, since);
  }

  /**
   * Returns events for a specific role identity, optionally filtered by
   * timestamp.
   *
   * Reads from the role's dedicated event file
   * `events-<canonicalSlug({org,team,role})>.jsonl`.
   *
   * @param taskId - The task identifier.
   * @param identity - Structured role identity.
   * @param since - Optional ISO timestamp; only events after this time are returned.
   * @returns Array of TaskEvent in chronological order.
   */
  async getEventsForRole(
    taskId: string,
    identity: RoleIdentity,
    since?: string,
  ): Promise<TaskEvent[]> {
    if (since !== undefined) {
      return readEventsForRoleSince(this.projectDir, taskId, identity, since);
    }
    return readEventsForRole(this.projectDir, taskId, identity);
  }

  /**
   * Returns events filtered by role across all event files.
   *
   * Scans every events*.jsonl in the task directory and matches on the
   * `event.role` payload field. This is what makes `?role=orchestrator`
   * work — orchestrator events live in events.jsonl rather than in any
   * per-role file.
   *
   * @param taskId - The task identifier.
   * @param role - The role identifier to match against `event.role`.
   * @param since - Optional ISO timestamp; only events after this time are returned.
   * @returns Array of matching TaskEvent in chronological order.
   */
  async getEventsByRole(taskId: string, role: string, since?: string): Promise<TaskEvent[]> {
    const all = since !== undefined
      ? await readEventsSince(this.projectDir, taskId, since)
      : await readEvents(this.projectDir, taskId);
    return all.filter((event) => event.role === role);
  }
}
