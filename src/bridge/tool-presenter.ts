/**
 * Zed-oriented tool-call presentation filter.
 *
 * Zed renders every `tool_call` / `tool_call_update` as a card, including the
 * raw command and its captured output. That is useful when auditing a run, but
 * noisy for everyday editing. Two opt-in modes trim the payload without
 * touching the underlying session log:
 *
 * - `DSH_ACP_TOOL_MODE=summary` — keep the tool title, execution outcome and
 *   elapsed time; drop command text, output, terminal metadata and the DSH
 *   tool-result snapshot. `DSH_ACP_TOOL_MERGE=1` additionally folds consecutive
 *   `execute` calls (within 15 s) into a single `bash ×N` card.
 * - `DSH_ACP_TOOL_MODE=minimal` — same stripping, titles collapse to the tool
 *   name only (kept for compatibility with earlier local patch sets).
 *
 * With neither variable set the filter is a no-op and the adapter keeps the
 * full ACP payload.
 */

import type { SessionUpdate } from "./translate.ts";

type Mutable = Record<string, unknown>;

export interface ToolPresenter {
    /** Returns the update to send, or `null` when the update should be dropped. */
    present(sessionId: string, update: SessionUpdate): SessionUpdate | null;
}

interface ToolMeta {
    start: number;
    kind?: string;
    name?: string;
    path?: string;
}

interface ExecGroup {
    id: string;
    count: number;
    start: number;
    last: number;
}

const MERGE_WINDOW_MS = 15_000;
const DURATION_VISIBLE_MS = 500;

function basename(value: string): string {
    const parts = value.split(/[\\/]/).filter((part) => part.length > 0);
    return parts.at(-1) ?? value;
}

function elapsed(start: number): string {
    const ms = Date.now() - start;
    return ms >= DURATION_VISIBLE_MS ? ` · ${(ms / 1000).toFixed(1)}s` : "";
}

function toolMode(): "summary" | "minimal" | undefined {
    const mode = process.env["DSH_ACP_TOOL_MODE"];
    if (mode === "summary" || mode === "minimal") return mode;
    return process.env["DSH_ACP_MINIMAL_TOOLS"] === "1" ? "minimal" : undefined;
}

/** Build a stateful presenter; one instance per ACP connection. */
export function createToolPresenter(): ToolPresenter {
    const meta = new Map<string, ToolMeta>();
    const execGroups = new Map<string, ExecGroup>();
    const execAliases = new Map<string, string>();

    const presentExecute = (
        sessionId: string,
        update: Mutable,
        state: ToolMeta,
        title: string,
    ): SessionUpdate | null => {
        const merge = process.env["DSH_ACP_TOOL_MERGE"] === "1";
        if (!merge) {
            return { ...update, title: title + elapsed(state.start) } as SessionUpdate;
        }
        const callId = String(update["toolCallId"]);
        const group = execGroups.get(sessionId);
        if (update["sessionUpdate"] === "tool_call") {
            if (group !== undefined && Date.now() - group.last < MERGE_WINDOW_MS) {
                group.count += 1;
                group.last = Date.now();
                execAliases.set(callId, group.id);
                return null;
            }
            execGroups.set(sessionId, {
                id: callId,
                count: 1,
                start: state.start,
                last: Date.now(),
            });
            return { ...update, title } as SessionUpdate;
        }
        const alias = execAliases.get(callId);
        if (alias === undefined) {
            return { ...update, title: title + elapsed(state.start) } as SessionUpdate;
        }
        const current = execGroups.get(sessionId);
        if (current === undefined) return null;
        const status = update["status"];
        if (status !== "completed" && status !== "failed") return null;
        execAliases.delete(callId);
        const outcome = status === "failed" ? " · exit≠0" : " · exit 0";
        return {
            ...update,
            toolCallId: current.id,
            title: `${title} ×${current.count}${outcome}${elapsed(current.start)}`,
        } as SessionUpdate;
    };

    return {
        present(sessionId, update) {
            const mode = toolMode();
            if (mode === undefined) return update;
            const record = update as unknown as Mutable;
            const kind = record["sessionUpdate"];
            if (kind !== "tool_call" && kind !== "tool_call_update") return update;

            const callId = record["toolCallId"];
            if (typeof callId !== "string") return update;

            let state = meta.get(callId);
            if (state === undefined) {
                state = { start: Date.now() };
                meta.set(callId, state);
            }
            const updateKind = record["kind"];
            if (typeof updateKind === "string") state.kind = updateKind;
            const updateName = record["name"];
            if (typeof updateName === "string") state.name = updateName;
            const locations = record["locations"];
            if (state.path === undefined && Array.isArray(locations) && locations.length > 0) {
                const first = locations[0] as Mutable | undefined;
                const path = first?.["path"];
                if (typeof path === "string") state.path = path;
            }

            const trimmed: Mutable = { ...record };
            delete trimmed["rawInput"];
            delete trimmed["rawOutput"];
            delete trimmed["_meta"];
            const content = trimmed["content"];
            if (Array.isArray(content)) {
                trimmed["content"] = content.filter(
                    (block) => block !== null && typeof block === "object" && (block as Mutable)["type"] === "diff",
                );
            }

            const isExec = state.kind === "execute";
            const base = typeof trimmed["name"] === "string" ? (trimmed["name"] as string) : (state.kind ?? "tool");

            if (mode === "minimal") {
                if (isExec) trimmed["title"] = base;
                return trimmed as unknown as SessionUpdate;
            }

            if (!isExec && record["sessionUpdate"] === "tool_call") execGroups.delete(sessionId);
            if (isExec) return presentExecute(sessionId, trimmed, state, base);

            const title = state.path === undefined ? base : `${base} · ${basename(state.path)}`;
            return { ...trimmed, title } as unknown as SessionUpdate;
        },
    };
}
