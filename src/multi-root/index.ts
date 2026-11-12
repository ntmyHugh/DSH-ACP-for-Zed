/**
 * Built-in ACP multi-root plugin entry: the session scope service that the
 * bridge and the two provider replacements share.
 *
 * The provider rows live in sibling entries so the profile patch can mount
 * them as separate Cordis plugins:
 *  - `deepseek-harness-acp-zed/multi-root`        (this scope)
 *  - `deepseek-harness-acp-zed/multi-root/fs`     (filesystem fence)
 *  - `deepseek-harness-acp-zed/multi-root/sandbox` (kernel sandbox)
 *
 * @module dsh-acp/multi-root
 */

export { AcpMultiRootScope, type AcpMultiRootScopeApi } from "./scope.ts";
export { default } from "./scope.ts";
