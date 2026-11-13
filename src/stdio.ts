/** Standard ACP profile transport: bind the embedded Host plugin to stdio. */

import type { Context } from "@deepseek-ai/cordis";

import { nodeAcpStream } from "./bundle.ts";
import { flushReplays } from "./bridge/replay-queue.ts";
import type { AcpServer } from "./server.ts";

export const name = "acp-stdio";
export const inject = ["acpServer"];

/**
 * Flush deferred `session/load` replays once a JSON-RPC response frame has been
 * written. A response carries an `id` and no `method`; notifications are the
 * opposite, so the probe does not need to parse the payload.
 */
function installReplayFlush(): void {
    const installed = Symbol.for("dsh-acp.replay-flush-installed");
    const holder = globalThis as unknown as Record<symbol, boolean | undefined>;
    if (holder[installed] === true) return;
    holder[installed] = true;
    const originalWrite = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
    process.stdout.write = ((...args: unknown[]): boolean => {
        const written = originalWrite(...args);
        try {
            const chunk = args[0];
            const text =
                typeof chunk === "string"
                    ? chunk
                    : chunk instanceof Uint8Array
                      ? Buffer.from(chunk).toString("utf8")
                      : "";
            if (text.includes('"id"') && !text.includes('"method"')) {
                flushReplays();
            }
        } catch {
            // The response path must never fail because of the flush probe.
        }
        return written;
    }) as typeof process.stdout.write;
}

export function apply(ctx: Context): unknown {
    installReplayFlush();
    const server = ctx.get("acpServer") as AcpServer;
    return server.connect(nodeAcpStream(process.stdin, process.stdout));
}
