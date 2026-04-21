/**
 * Shared utility functions for the Forjis web dashboard API controllers.
 *
 * Provides JSON response serialization, error response formatting,
 * URL query parameter parsing, and path parameter extraction. All
 * controller functions use these helpers for consistent response formatting.
 */

import type { ServerResponse } from 'node:http';
import type { ErrorResponse } from './types.js';

/**
 * Sends a JSON response with the given status code and body.
 *
 * Sets Content-Type to application/json with UTF-8 charset,
 * writes the status code, serializes the body as JSON, and ends
 * the response. If headers have already been sent, returns without
 * writing to avoid errors on already-flushed responses.
 *
 * @param res - The HTTP server response object.
 * @param status - The HTTP status code to send.
 * @param body - The response body to serialize as JSON.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Sends an error response using the ErrorResponse envelope format.
 *
 * Delegates to sendJson with the standard error shape used by all
 * API error responses: { error, code, details? }.
 *
 * @param res - The HTTP server response object.
 * @param status - The HTTP status code to send.
 * @param code - The machine-readable error code (e.g., "NOT_FOUND").
 * @param error - The human-readable error message.
 * @param details - Optional additional error details.
 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  details?: Record<string, unknown>
): void {
  const body: ErrorResponse = { error, code };
  if (details !== undefined) {
    body.details = details;
  }
  sendJson(res, status, body);
}

/**
 * Parses query parameters from a URL string.
 *
 * Uses the URL constructor with a dummy base to safely extract search
 * parameters from both absolute and relative URL strings.
 *
 * @param url - The URL string to parse (can be relative, e.g., "/api/tasks?since=2026-01-01").
 * @returns A URLSearchParams object with the parsed query parameters.
 */
export function parseQuery(url: string): URLSearchParams {
  const parsed = new URL(url, 'http://localhost');
  return parsed.searchParams;
}

/**
 * Extracts a path parameter from a URL path at the given segment index.
 *
 * Splits the pathname on "/" separators, filters out empty segments,
 * and returns the segment at the specified zero-based index. Returns
 * an empty string if the index is out of bounds.
 *
 * @param pathname - The URL pathname (e.g., "/api/tasks/my-task/plan").
 * @param segmentIndex - The zero-based index of the segment to extract.
 * @returns The path segment string, or empty string if index is out of bounds.
 */
export function extractPathParam(pathname: string, segmentIndex: number): string {
  const segments = pathname.split('/').filter(s => s !== '');
  if (segmentIndex < 0 || segmentIndex >= segments.length) {
    return '';
  }
  return segments[segmentIndex];
}
