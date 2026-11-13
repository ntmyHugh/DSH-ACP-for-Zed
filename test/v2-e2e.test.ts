/**
 * ACP v2 end-to-end smoke test.
 *
 * Boots the real standalone server with `DSH_ACP_V2=1` and speaks the v2
 * protocol over stdio: initialize, session/new and a `/status` prompt that the
 * adapter answers locally (no model call). Verifies the v2 handshake, the
 * `running` → `idle` state snapshots and the message-id prompt response.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

// The standalone server needs the DSH harness packages from the checkout. A
// pruned install (or a checkout that only vendors the ACP package) cannot boot
// it, so the end-to-end case is skipped instead of failing the suite.
const HARNESS_AVAILABLE = existsSync(join(ROOT, "node_modules", "@deepseek-ai", "cosmokit"));

class V2Client {
    readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private buffer = "";
    private stderr = "";
    private nextId = 1;

    constructor(private readonly child: ReturnType<typeof spawn>) {
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            this.stderr += chunk;
        });
        child.stdout?.on("data", (chunk: string) => {
            this.buffer += chunk;
            let index = this.buffer.indexOf("\n");
            while (index >= 0) {
                const line = this.buffer.slice(0, index).trim();
                this.buffer = this.buffer.slice(index + 1);
                if (line.length > 0) this.dispatch(line);
                index = this.buffer.indexOf("\n");
            }
        });
    }

    private dispatch(line: string): void {
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message["id"];
        if (typeof id === "number" && this.pending.has(id)) {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            if (message["error"] !== undefined) {
                pending?.reject(new Error(JSON.stringify(message["error"])));
            } else {
                pending?.resolve(message["result"]);
            }
            return;
        }
        if (typeof message["method"] === "string") {
            this.notifications.push({
                method: message["method"],
                params: (message["params"] ?? {}) as Record<string, unknown>,
            });
        }
    }

    request(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout waiting for ${method}\nstderr:\n${this.stderr.slice(-2000)}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    get stderrTail(): string {
        return this.stderr.slice(-2000);
    }
}

describe.skipIf(!HARNESS_AVAILABLE)("ACP v2 transport", () => {
    let sessionRoot: string;
    let workspace: string;
    let child: ReturnType<typeof spawn>;
    let client: V2Client;

    beforeAll(() => {
        sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-v2-"));
        workspace = mkdtempSync(join(tmpdir(), "dsh-acp-v2-ws-"));
        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            DEEPSEEK_API_KEY: "sk-test-e2e-not-a-real-key",
            DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
            DSH_SESSION_ROOT: sessionRoot,
            DSH_HOME: join(sessionRoot, "home"),
            DSH_ACP_WORKSPACE: workspace,
            DSH_PATH: ROOT,
            DSH_ACP_V2: "1",
        };
        child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts"], {
            cwd: ROOT,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        client = new V2Client(child);
    }, 120_000);

    afterAll(() => {
        child?.kill();
        rmSync(sessionRoot, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    });

    it("handshakes with v2 and streams state updates around a prompt", async () => {
        const initialized = (await client.request("initialize", { protocolVersion: 2 })) as Record<string, unknown>;
        expect(initialized["protocolVersion"]).toBe(2);
        expect(initialized["info"]).toMatchObject({ name: "dsh-acp" });
        expect(initialized["agentInfo"]).toBeUndefined();

        const created = (await client.request("session/new", { cwd: workspace, mcpServers: [] })) as Record<string, unknown>;
        const sessionId = created["sessionId"];
        expect(typeof sessionId).toBe("string");

        const response = (await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "/status" }],
        })) as Record<string, unknown>;
        expect(typeof response["messageId"]).toBe("string");
        expect(response["stopReason"]).toBeUndefined();

        const updates = client.notifications
            .filter((entry) => entry.method === "session/update")
            .map((entry) => entry.params["update"] as Record<string, unknown>);
        const states = updates.filter((update) => update["sessionUpdate"] === "state_update").map((update) => update["state"]);
        expect(states[0]).toBe("running");
        expect(states).toContain("idle");
        // Custom bridge markers must never reach the client.
        expect(updates.some((update) => String(update["sessionUpdate"]).startsWith("_dsh/"))).toBe(false);
    }, 120_000);
});
