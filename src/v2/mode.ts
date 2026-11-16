/**
 * Process-wide switch for the experimental ACP v2 transport.
 *
 * The proxy is started for every connection so a v2-capable client can
 * negotiate v2 without any environment variable. `DSH_ACP_V2=0` is the escape
 * hatch that restores the raw v1 transport.
 */

const ACTIVE = Symbol.for("dsh-acp.v2-proxy-active");

/** True when the operator forced the legacy v1 transport. */
export function proxyForcedOff(): boolean {
    return process.env["DSH_ACP_V2"] === "0";
}

/** Record that this process serves ACP through the v2 proxy. */
export function markProxyActive(): void {
    (globalThis as unknown as Record<symbol, boolean>)[ACTIVE] = true;
}

/** True when a proxy is mounted, so internal markers may be emitted. */
export function proxyActive(): boolean {
    return (globalThis as unknown as Record<symbol, boolean>)[ACTIVE] === true;
}
