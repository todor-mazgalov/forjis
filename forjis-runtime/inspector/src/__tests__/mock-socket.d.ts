/**
 * Local ambient declarations for `mock-socket` (no first-party types).
 *
 * Covers only the surface the Inspector test suites use: the `Server` class
 * with its constructor, `on`/`send`/`close`/`clients`/`stop` members. If the
 * test surface grows, extend this module instead of depending on
 * `@types/mock-socket` (which does not exist for 9.3.x).
 */
declare module 'mock-socket' {
  /** A single connected client from the server's point of view. */
  export interface MockSocketClient {
    /**
     * Send a string payload to the client.
     *
     * @param data - Payload to deliver.
     */
    send(data: string): void;

    /**
     * Close the server-side half of the client socket.
     *
     * @param options - Optional close code/reason.
     */
    close(options?: { code?: number; reason?: string; wasClean?: boolean }): void;
  }

  /**
   * Minimal event map surfaced by the `Server` class.
   */
  export interface MockSocketServerEventMap {
    connection: (socket: MockSocketClient) => void;
    message: (data: string) => void;
    close: () => void;
  }

  /** In-process WebSocket server that intercepts `new WebSocket(url)` globally. */
  export class Server {
    /**
     * Create a new mock server listening on the given URL.
     *
     * @param url - Absolute WebSocket URL (e.g. `ws://localhost:9999/path`).
     * @param options - Optional server options (ignored by the tests).
     */
    public constructor(url: string, options?: { mock?: boolean });

    /**
     * Subscribe to a server event.
     *
     * @param event - Event name (`connection`, `message`, `close`).
     * @param handler - Callback invoked with event-specific arguments.
     */
    public on<K extends keyof MockSocketServerEventMap>(
      event: K,
      handler: MockSocketServerEventMap[K],
    ): void;

    /**
     * Subscribe to per-client events such as `message`.
     *
     * @param event - Event name.
     * @param handler - Callback.
     */
    public on(event: string, handler: (...args: unknown[]) => void): void;

    /**
     * Emit a payload to every connected client.
     *
     * @param data - Payload to broadcast.
     */
    public emit(event: string, ...args: unknown[]): void;

    /**
     * Simulate the server sending a payload to every connected client.
     *
     * @param data - Payload to send.
     */
    public send(data: string): void;

    /**
     * Close the server; disconnects every connected client.
     *
     * @param options - Close options forwarded to each client.
     */
    public close(options?: { code?: number; reason?: string; wasClean?: boolean }): void;

    /**
     * Tear down the server and remove the global WebSocket shim registration.
     */
    public stop(): void;

    /**
     * Iterate every connected client.
     *
     * @returns Array snapshot of currently connected clients.
     */
    public clients(): MockSocketClient[];
  }
}
