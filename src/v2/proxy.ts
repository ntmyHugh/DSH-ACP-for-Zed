/**
 * ACP v2 proxy: expose the ACP v1 bridge to a v2 client.
 *
 * The proxy owns the client transport (stdio) and mounts the existing v1
 * bridge on an in-memory duplex pair. For v1 clients every frame is forwarded
 * verbatim, so the stable transport is untouched; for v2 clients the proxy
 * translates the request/response and notification shapes and synthesises the
 * v2 `state_update` snapshots.
 *
 * v2 differs from v1 in the places this module handles:
 *   - `initialize` reports `info` / `capabilities` instead of
 *     `agentInfo` / `agentCapabilities`, and `auth/login` replaces
 *     `authenticate`;
 *   - there is no `session/load`; a client resumes with `session/resume`;
 *   - a prompt response carries `messageId` and no stop reason — the stop
 *     reason moves into the idle `state_update`;
 *   - agents may send `state_update` snapshots at any time, including while no
 *     prompt request is pending, which is how background goal rounds stay
 *     visible as "running".
 */

import { randomUUID } from "node:crypto";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { createInterface, type Interface as LineInterface } from "node:readline";

import { idleState, mapStopReason, runningState, translateUpdate, type V2Update } from "./updates.ts";

type JsonRpcId = string | number;

interface Frame {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown> | undefined;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export interface V2ProxyOptions {
    /** Client transport (the ACP profile's stdin). */
    input: Readable;
    /** Client transport (the ACP profile's stdout). */
    output: Writable;
    /** Mount the ACP v1 bridge on the given in-memory pair. */
    connect: (input: Readable, output: Writable) => unknown;
}

/** Custom update the bridge uses to report autonomous goal activity. */
const GOAL_ACTIVITY_UPDATE = "_dsh/goal_activity";

/** Custom update the bridge sends when a deferred replay finished. */
const REPLAY_COMPLETE_UPDATE = "_dsh/replay_complete";

const CLIENT_FS_TERMINAL_METHODS = new Set([
    "fs/read_text_file",
    "fs/write_text_file",
    "terminal/create",
    "terminal/output",
    "terminal/release",
    "terminal/wait_for_exit",
    "terminal/kill",
]);

function isMethod(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function idKey(id: JsonRpcId | undefined): string {
    return String(id ?? "");
}

export function startV2Proxy(options: V2ProxyOptions): { close: () => void } {
    const toBridge = new PassThrough();
    const fromBridge = new PassThrough();
    options.connect(toBridge, fromBridge);

    let v2 = false;
    const clientCalls = new Map<string, { method: string; v2: boolean }>();
    const bridgeCalls = new Map<string, { method: string }>();
    let lastUserMessageId: string | undefined;
    let goalActive = false;
    let promptOpen = false;
    // v2 orders replay before the resume response, so the response is held
    // until the bridge reports that the replay finished.
    let pendingResume: { id: JsonRpcId; result: unknown } | null = null;
    // A replay can also finish before the bridge answers the resume request;
    // remember that so the response is released immediately in that case.
    let replayDone = false;

    const sendClient = (frame: Frame): void => {
        if (options.output.destroyed) return;
        options.output.write(`${JSON.stringify(frame)}\n`);
    };
    const sendBridge = (frame: Frame): void => {
        toBridge.write(`${JSON.stringify(frame)}\n`);
    };

    const sendClientUpdate = (sessionId: unknown, update: V2Update): void => {
        sendClient({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update },
        });
    };

    const setState = (state: V2Update): void => {
        // State updates are per session; the proxy tracks one live session at
        // a time, which matches how a single Zed thread drives the agent.
        sendClientUpdate(currentSessionId, state);
    };
    let currentSessionId: string | undefined;

    const translateResult = (method: string, result: unknown): unknown => {
        const value = (result ?? {}) as Record<string, unknown>;
        switch (method) {
            case "initialize": {
                const info = (value["agentInfo"] ?? {}) as Record<string, unknown>;
                const caps = (value["agentCapabilities"] ?? {}) as Record<string, unknown>;
                return {
                    protocolVersion: 2,
                    info: {
                        name: typeof info["name"] === "string" ? info["name"] : "dsh-acp",
                        title: typeof info["title"] === "string" ? info["title"] : "DeepSeek Harness",
                        version: typeof info["version"] === "string" ? info["version"] : "0.0.0",
                    },
                    capabilities: translateCapabilities(caps),
                    ...(Array.isArray(value["authMethods"])
                        ? { authMethods: translateAuthMethods(value["authMethods"]) }
                        : {}),
                    ...(value["_meta"] !== undefined ? { _meta: value["_meta"] } : {}),
                };
            }
            case "session/new":
                if (typeof value["sessionId"] === "string") currentSessionId = value["sessionId"];
                return {
                    sessionId: value["sessionId"],
                    ...(value["configOptions"] !== undefined ? { configOptions: value["configOptions"] } : {}),
                    ...(value["availableCommands"] !== undefined
                        ? { availableCommands: value["availableCommands"] }
                        : {}),
                };
            case "session/load":
                // v2 resume: the proxy holds this response until the replay
                // marker arrives; the payload only carries the configuration.
                return {
                    ...(value["configOptions"] !== undefined ? { configOptions: value["configOptions"] } : {}),
                    ...(value["availableCommands"] !== undefined
                        ? { availableCommands: value["availableCommands"] }
                        : {}),
                };
            case "session/prompt": {
                const stopReason = mapStopReason(value["stopReason"]);
                if (!goalActive) {
                    setState(idleState(stopReason));
                }
                promptOpen = false;
                return { messageId: lastUserMessageId ?? randomUUID() };
            }
            default:
                return value;
        }
    };

    const handleClientLine = (line: string): void => {
        const text = line.trim();
        if (text.length === 0) return;
        let frame: Frame;
        try {
            frame = JSON.parse(text) as Frame;
        } catch {
            return;
        }

        if (frame.id !== undefined && isMethod(frame.method)) {
            const method = frame.method;
            if (method === "initialize") {
                const requested = frame.params?.["protocolVersion"];
                v2 = typeof requested === "number" && requested >= 2;
                const params = v2
                    ? {
                          ...frame.params,
                          protocolVersion: 1,
                          clientCapabilities: {
                              fs: { readTextFile: false, writeTextFile: false },
                              terminal: false,
                          },
                      }
                    : frame.params;
                clientCalls.set(idKey(frame.id), { method: "initialize", v2 });
                sendBridge({ jsonrpc: "2.0", id: frame.id, method, params });
                return;
            }

            if (!v2) {
                sendBridge(frame);
                return;
            }

            const params = { ...(frame.params ?? {}) } as Record<string, unknown>;
            let bridgeMethod = method;
            switch (method) {
                case "session/resume":
                    bridgeMethod = "session/load";
                    break;
                case "auth/login":
                    bridgeMethod = "authenticate";
                    break;
                case "auth/logout":
                    bridgeMethod = "logout";
                    break;
                case "session/prompt": {
                    promptOpen = true;
                    const sessionId = params["sessionId"];
                    if (typeof sessionId === "string") currentSessionId = sessionId;
                    lastUserMessageId = randomUUID();
                    setState(runningState());
                    break;
                }
                case "session/new": {
                    const sessionId = params["cwd"];
                    if (typeof sessionId === "string") currentSessionId = undefined;
                    break;
                }
                case "session/cancel":
                    break;
                default:
                    break;
            }
            if (method === "session/resume") replayDone = false;
            clientCalls.set(idKey(frame.id), { method, v2: true });
            sendBridge({ jsonrpc: "2.0", id: frame.id, method: bridgeMethod, params });
            return;
        }

        if (frame.id !== undefined && !isMethod(frame.method)) {
            // Client answering a bridge-initiated request (permission etc.).
            const call = bridgeCalls.get(idKey(frame.id));
            if (call !== undefined) bridgeCalls.delete(idKey(frame.id));
            sendBridge(frame);
            return;
        }

        // Notification from the client (session/cancel, $/cancel_request).
        sendBridge(frame);
    };

    const handleBridgeLine = (line: string): void => {
        const text = line.trim();
        if (text.length === 0) return;
        let frame: Frame;
        try {
            frame = JSON.parse(text) as Frame;
        } catch {
            return;
        }

        if (frame.id !== undefined && isMethod(frame.method)) {
            const method = frame.method;
            if (v2 && CLIENT_FS_TERMINAL_METHODS.has(method)) {
                sendBridge({
                    jsonrpc: "2.0",
                    id: frame.id,
                    error: { code: -32601, message: `ACP v2 has no ${method} client method` },
                });
                return;
            }
            if (v2 && method === "session/request_permission") {
                bridgeCalls.set(idKey(frame.id), { method });
                sendClient({
                    jsonrpc: "2.0",
                    id: frame.id,
                    method,
                    params: translatePermissionParams(frame.params ?? {}),
                });
                return;
            }
            sendClient(frame);
            return;
        }

        if (frame.id !== undefined && !isMethod(frame.method)) {
            const call = clientCalls.get(idKey(frame.id));
            clientCalls.delete(idKey(frame.id));
            if (call !== undefined && call.v2) {
                const translated = translateResult(call.method, frame.result);
                if (call.method === "session/resume" && frame.id !== undefined) {
                    if (replayDone) {
                        replayDone = false;
                        sendClient({ jsonrpc: "2.0", id: frame.id, result: translated });
                        return;
                    }
                    pendingResume = { id: frame.id, result: translated };
                    setTimeout(() => {
                        if (pendingResume === null) return;
                        const held = pendingResume;
                        pendingResume = null;
                        sendClient({ jsonrpc: "2.0", id: held.id, result: held.result });
                    }, 3000);
                    return;
                }
                sendClient({ jsonrpc: "2.0", id: frame.id, result: translated });
                return;
            }
            sendClient(frame);
            return;
        }

        if (isMethod(frame.method)) {
            if (!v2) {
                sendClient(frame);
                return;
            }
            if (frame.method === "session/update") {
                const params = frame.params ?? {};
                const sessionId = params["sessionId"];
                if (typeof sessionId === "string") currentSessionId = sessionId;
                const update = params["update"] as { sessionUpdate?: unknown } | undefined;
                if (update?.sessionUpdate === REPLAY_COMPLETE_UPDATE) {
                    replayDone = true;
                    if (pendingResume !== null) {
                        const held = pendingResume;
                        pendingResume = null;
                        replayDone = false;
                        sendClient({ jsonrpc: "2.0", id: held.id, result: held.result });
                    }
                    return;
                }
                if (update?.sessionUpdate === GOAL_ACTIVITY_UPDATE) {
                    const active = (update as Record<string, unknown>)["active"] === true;
                    goalActive = active;
                    if (active) {
                        setState(runningState());
                    } else if (!promptOpen) {
                        setState(idleState("end_turn"));
                    }
                    return;
                }
                if (update !== undefined && typeof update.sessionUpdate === "string") {
                    for (const translated of translateUpdate(update as { sessionUpdate: string })) {
                        sendClientUpdate(sessionId, translated);
                    }
                    return;
                }
            }
            sendClient(frame);
            return;
        }
        sendClient(frame);
    };

    const clientLines: LineInterface = createInterface({ input: options.input });
    const bridgeLines: LineInterface = createInterface({ input: fromBridge });
    clientLines.on("line", handleClientLine);
    bridgeLines.on("line", handleBridgeLine);

    return {
        close: () => {
            clientLines.close();
            bridgeLines.close();
            toBridge.end();
            fromBridge.end();
        },
    };
}

function translateCapabilities(caps: Record<string, unknown>): Record<string, unknown> {
    const prompt = (caps["promptCapabilities"] ?? {}) as Record<string, unknown>;
    const sessionCaps = (caps["sessionCapabilities"] ?? {}) as Record<string, unknown>;
    const spec = (caps["mcpCapabilities"] ?? {}) as Record<string, unknown>;
    return {
        session: {
            prompt: {
                image: prompt["image"] === true,
                audio: prompt["audio"] === true,
                embeddedContext: prompt["embeddedContext"] === true,
            },
            mcp: { stdio: spec["sse"] !== undefined, http: spec["http"] === true },
            ...(sessionCaps["delete"] !== undefined ? { delete: {} } : {}),
            ...(sessionCaps["additionalDirectories"] !== undefined ? { additionalDirectories: {} } : {}),
        },
        ...(caps["auth"] !== undefined ? { auth: {} } : {}),
        ...(caps["_meta"] !== undefined ? { _meta: caps["_meta"] } : {}),
    };
}

function translateAuthMethods(methods: unknown[]): unknown[] {
    return methods.map((entry) => {
        const method = (entry ?? {}) as Record<string, unknown>;
        const id = method["id"] ?? method["methodId"];
        return {
            methodId: typeof id === "string" ? id : "unknown",
            name: typeof method["name"] === "string" ? method["name"] : "Sign in",
            ...(typeof method["description"] === "string" ? { description: method["description"] } : {}),
        };
    });
}

function translatePermissionParams(params: Record<string, unknown>): Record<string, unknown> {
    const toolCall = (params["toolCall"] ?? {}) as Record<string, unknown>;
    const title = typeof toolCall["title"] === "string" ? toolCall["title"] : "Permission required";
    return {
        sessionId: params["sessionId"],
        title,
        ...(typeof toolCall["kind"] === "string" ? { description: `Tool: ${String(toolCall["kind"])}` } : {}),
        options: params["options"] ?? [],
    };
}
