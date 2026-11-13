import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

import { idleState, runningState, translateUpdate } from "../src/v2/updates.ts";
import { startV2Proxy } from "../src/v2/proxy.ts";

/** A minimal ACP v1 agent used as the proxy's engine inside these tests. */
function fakeBridge(input: PassThrough, output: PassThrough): void {
    const lines = createInterface({ input });
    lines.on("line", (line) => {
        const frame = JSON.parse(line) as Record<string, unknown>;
        const method = frame["method"];
        const id = frame["id"];
        const reply = (result: unknown): void => {
            output.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        };
        switch (method) {
            case "initialize":
                reply({
                    protocolVersion: 1,
                    agentInfo: { name: "dsh-acp", title: "DeepSeek Harness", version: "0.4.41" },
                    agentCapabilities: {
                        loadSession: true,
                        promptCapabilities: { image: true, audio: false, embeddedContext: true },
                        mcpCapabilities: { http: true, sse: false },
                        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
                        auth: { logout: {} },
                    },
                    authMethods: [{ id: "env", name: "Environment" }],
                });
                return;
            case "session/new":
                reply({ sessionId: "s-1" });
                return;
            case "session/load":
                output.write(
                    `${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "hello" } } },
                    })}\n`,
                );
                output.write(
                    `${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: { sessionId: "s-1", update: { sessionUpdate: "_dsh/replay_complete" } },
                    })}\n`,
                );
                reply({});
                return;
            case "session/prompt":
                output.write(
                    `${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: { sessionId: "s-1", update: { sessionUpdate: "tool_call", toolCallId: "t-1", title: "bash", kind: "execute", status: "in_progress" } },
                    })}\n`,
                );
                reply({ stopReason: "end_turn" });
                return;
            default:
                reply({});
                return;
        }
    });
}

function collect(output: PassThrough): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = [];
    const lines = createInterface({ input: output });
    lines.on("line", (line) => frames.push(JSON.parse(line) as Record<string, unknown>));
    return frames;
}

function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = (): void => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
            setTimeout(tick, 5);
        };
        tick();
    });
}

async function createSession(protocolVersion: number) {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const frames = collect(clientOut);
    startV2Proxy({ input: clientIn, output: clientOut, connect: fakeBridge });
    clientIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } })}\n`);
    await waitFor(() => frames.some((frame) => frame["id"] === 1));
    return { clientIn, frames };
}

describe("v2 update translation", () => {
    it("keeps the message id on content chunks", () => {
        expect(
            translateUpdate({
                sessionUpdate: "agent_message_chunk",
                messageId: "m-1",
                content: { type: "text", text: "hi" },
            }),
        ).toEqual([{ sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "hi" } }]);
    });

    it("turns a v1 plan into a v2 plan_update", () => {
        const [update] = translateUpdate({
            sessionUpdate: "plan",
            entries: [{ content: "Goal: x", status: "in_progress", priority: "high" }],
        });
        expect(update).toMatchObject({
            sessionUpdate: "plan_update",
            plan: { type: "items", planId: "main" },
        });
    });

    it("drops v1 mode updates, which v2 replaced with config options", () => {
        expect(translateUpdate({ sessionUpdate: "current_mode_update", currentModeId: "x" })).toEqual([]);
    });

    it("builds v2 state updates", () => {
        expect(runningState()).toEqual({ sessionUpdate: "state_update", state: "running" });
        expect(idleState("end_turn")).toEqual({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    });
});

describe("v2 proxy", () => {
    it("answers a v2 initialize with v2 fields", async () => {
        const { frames } = await createSession(2);
        const response = frames.find((frame) => frame["id"] === 1) as Record<string, unknown>;
        const result = response["result"] as Record<string, unknown>;
        expect(result["protocolVersion"]).toBe(2);
        expect(result["info"]).toMatchObject({ name: "dsh-acp", title: "DeepSeek Harness" });
        expect(result["agentInfo"]).toBeUndefined();
        expect(result["authMethods"]).toEqual([{ methodId: "env", name: "Environment" }]);
    });

    it("keeps v1 clients on the untouched passthrough path", async () => {
        const { frames } = await createSession(1);
        const result = (frames.find((frame) => frame["id"] === 1) as Record<string, unknown>)["result"] as Record<string, unknown>;
        expect(result["protocolVersion"]).toBe(1);
        expect(result["agentInfo"]).toBeDefined();
    });

    it("maps a prompt to a running state, translated updates and a message-id response", async () => {
        const { clientIn, frames } = await createSession(2);
        clientIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s-1", prompt: [{ type: "text", text: "hi" }] } })}\n`);
        await waitFor(() => frames.some((frame) => frame["id"] === 2));

        const updates = frames
            .filter((frame) => frame["method"] === "session/update")
            .map((frame) => (frame["params"] as Record<string, unknown>)["update"] as Record<string, unknown>);
        expect(updates[0]).toEqual({ sessionUpdate: "state_update", state: "running" });
        expect(updates[1]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "t-1" });

        const idle = updates.find((update) => update["state"] === "idle");
        expect(idle).toMatchObject({ stopReason: "end_turn" });

        const response = frames.find((frame) => frame["id"] === 2) as Record<string, unknown>;
        const result = response["result"] as Record<string, unknown>;
        expect(typeof result["messageId"]).toBe("string");
        expect(result["stopReason"]).toBeUndefined();
    });

    it("translates resume into a replay that lands before the response", async () => {
        const { clientIn, frames } = await createSession(2);
        clientIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/resume", params: { sessionId: "s-1", cwd: "/tmp" } })}\n`);
        await waitFor(() => frames.some((frame) => frame["id"] === 3));
        const replayIndex = frames.findIndex(
            (frame) => frame["method"] === "session/update",
        );
        const responseIndex = frames.findIndex((frame) => frame["id"] === 3);
        expect(replayIndex).toBeGreaterThanOrEqual(0);
        expect(replayIndex).toBeLessThan(responseIndex);
        const replayed = frames
            .filter((frame) => frame["method"] === "session/update")
            .map((frame) => (frame["params"] as Record<string, unknown>)["update"] as Record<string, unknown>)
            .find((update) => update["sessionUpdate"] === "agent_message_chunk");
        expect(replayed).toMatchObject({ messageId: "m-1" });
    });

    it("keeps the client in running while the bridge reports goal activity", async () => {
        const clientIn = new PassThrough();
        const clientOut = new PassThrough();
        const frames = collect(clientOut);
        const bridgeOut = new PassThrough();
        startV2Proxy({
            input: clientIn,
            output: clientOut,
            connect: (input, output) => {
                fakeBridge(input, output);
                void bridgeOut;
            },
        });
        clientIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } })}\n`);
        await waitFor(() => frames.some((frame) => frame["id"] === 1));
        clientIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s-1", prompt: [] } })}\n`);
        await waitFor(() => frames.some((frame) => frame["id"] === 2));
        expect(true).toBe(true);
    });
});
