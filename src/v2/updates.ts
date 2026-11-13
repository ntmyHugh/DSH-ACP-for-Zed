/**
 * ACP v1 → v2 session-update translation.
 *
 * The bridge core speaks ACP v1 (it is battle-tested by the stable transport);
 * the v2 proxy keeps that core and rewrites its output into the v2 shapes.
 * Only the differences that matter for rendering are mapped here:
 *
 * - v2 requires a `messageId` on content chunks (the bridge already sends one);
 * - v1 `tool_call` becomes a v2 `tool_call_update` upsert;
 * - v1 `plan` becomes a v2 `plan_update` carrying a `{type:"items"}` content;
 * - v1 `current_mode_update` has no v2 equivalent (v2 uses config options);
 * - per-message lifecycle notices are consumed by the proxy, not forwarded.
 */

/** Structural view of a v1 session update (the bridge's own type is wider). */
export type V1Update = { sessionUpdate: string; [key: string]: unknown };

/** Structural view of a v2 session update. */
export type V2Update = { sessionUpdate: string; [key: string]: unknown };

/** Plan id used for the single plan the bridge maintains per session. */
export const PLAN_ID = "main";

function chunk(messageId: unknown, content: unknown, sessionUpdate: string): V2Update {
    return { sessionUpdate, messageId: typeof messageId === "string" ? messageId : "", content };
}

function toolCallUpdate(update: V1Update): V2Update {
    const out: V2Update = { sessionUpdate: "tool_call_update" };
    for (const key of [
        "toolCallId",
        "title",
        "name",
        "kind",
        "status",
        "content",
        "locations",
        "rawInput",
        "rawOutput",
        "_meta",
    ]) {
        if (update[key] !== undefined) out[key] = update[key];
    }
    return out;
}

/** Translate one v1 update into zero or more v2 updates. */
export function translateUpdate(update: V1Update): V2Update[] {
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return [chunk(update["messageId"], update["content"], update.sessionUpdate)];
        case "tool_call":
        case "tool_call_update":
            return [toolCallUpdate(update)];
        case "plan":
            return [
                {
                    sessionUpdate: "plan_update",
                    plan: {
                        type: "items",
                        planId: PLAN_ID,
                        entries: Array.isArray(update["entries"]) ? update["entries"] : [],
                    },
                },
            ];
        case "available_commands_update":
            return [{ sessionUpdate: "available_commands_update", availableCommands: update["availableCommands"] ?? [] }];
        case "config_option_update":
            return [{ sessionUpdate: "config_option_update", configOptions: update["configOptions"] ?? [] }];
        case "session_info_update":
            return [{ sessionUpdate: "session_info_update", title: update["title"], updatedAt: update["updatedAt"] }];
        case "usage_update":
            return [
                {
                    sessionUpdate: "usage_update",
                    used: update["used"] ?? 0,
                    size: update["size"] ?? 0,
                    ...(update["cost"] !== undefined ? { cost: update["cost"] } : {}),
                },
            ];
        case "notice":
        case "compaction_update":
        case "compaction_summary_chunk":
            return [{ ...update }];
        case "current_mode_update":
            // v2 replaced session modes with config options; the bridge still
            // sends mode updates for v1 clients, so drop them here.
            return [];
        default:
            // `_`-prefixed custom updates and unknown future variants pass
            // through: v2 explicitly reserves `_` names for implementations.
            return [{ ...update }];
    }
}

/** A state update telling the client the agent started or stopped working. */
export function runningState(): V2Update {
    return { sessionUpdate: "state_update", state: "running" };
}

export function idleState(stopReason: string): V2Update {
    return { sessionUpdate: "state_update", state: "idle", stopReason };
}

/** Map a v1 stop reason onto a v2 one; v2 keeps the same vocabulary. */
export function mapStopReason(value: unknown): string {
    return typeof value === "string" && value.length > 0 ? value : "end_turn";
}
