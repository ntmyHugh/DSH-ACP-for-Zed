/**
 * Deferred `session/load` replay queue.
 *
 * Zed (and other clients that register a session only after the `session/load`
 * response arrives) drop any `session/update` notification that references a
 * session they do not know yet. The ACP specification allows an agent to replay
 * history before it answers, so the server defers its replay closures until the
 * response for that request is on the wire, and the transport flushes them.
 *
 * `stdio.ts` calls {@link flushReplays} after writing a JSON-RPC response frame;
 * `restoreSession` uses {@link replayAfterResponse} to park its replay closure.
 * The queue lives on a global symbol so bundled entry points that inline this
 * module share one instance.
 */

const QUEUE_KEY = Symbol.for("dsh-acp.replay-queue");

interface ReplayQueue {
    pending: Array<() => void>;
}

function replayQueue(): ReplayQueue {
    const holder = globalThis as unknown as Record<symbol, ReplayQueue | undefined>;
    const existing = holder[QUEUE_KEY];
    if (existing !== undefined) return existing;
    const created: ReplayQueue = { pending: [] };
    holder[QUEUE_KEY] = created;
    return created;
}

/** Park a replay closure until the current request's response has been written. */
export function replayAfterResponse(replay: () => void): void {
    replayQueue().pending.push(replay);
}

/** Run every parked replay closure in arrival order. Never throws. */
export function flushReplays(): void {
    const queue = replayQueue();
    if (queue.pending.length === 0) return;
    const pending = queue.pending.splice(0);
    for (const replay of pending) {
        try {
            replay();
        } catch {
            // A failed replay must not break the response path.
        }
    }
}
