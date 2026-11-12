# Zed 集成说明（DSH-ACP-for-Zed）

这个 fork 是 [`openma-ai/deepseek-harness-acp`](https://github.com/openma-ai/deepseek-harness-acp) 的 Zed 定向分支，把日常使用 Zed 时遇到的几处兼容性与展示问题在**源码层**修掉，避免再对发布产物做 dist 补丁。

上游版本基线：`0.4.41`。除下列改动外，其余行为与上游一致。

## 改动一览

### 1. `session/load` 回放改到响应之后

ACP 允许 agent 在响应前推送历史，但 Zed 只在收到 `session/load` 响应后才登记会话，先到的 `session/update` 会被判为未知会话丢弃，表现为「恢复的线程没有历史」。

- `src/bridge/replay-queue.ts`：回放闭包入队；
- `src/bridge/index.ts`：`restoreSession` 改用 `replayAfterResponse(...)`；
- `src/stdio.ts`：在写出响应帧（有 `id`、无 `method`）后调用 `flushReplays()`。

判定依据是「响应字节已经写出」，与耗时无关：即使 `session/load` 在大会话上耗时数十秒，回放也紧贴响应之后。

### 2. 思考块默认不发送

Zed 的 Thinking 区域会把推理全文（含模型自己写的命令草稿）展示出来，日常阅读噪音很大。

| 环境变量 | 行为 |
|---|---|
| 不设置 | 不发送 `agent_thought_chunk` |
| `DSH_ACP_THOUGHT_PREVIEW=<n>` | 每条消息最多发送前 n 个字符 |
| `DSH_ACP_SHOW_THOUGHTS=1` | 发送全文（由客户端 `agent.thinking_display` 决定折叠） |

### 3. 工具卡片详略

| 环境变量 | 行为 |
|---|---|
| 不设置 | 原样发送（命令原文、输出、终端元数据） |
| `DSH_ACP_TOOL_MODE=summary` | 标题为 `read · 文件名`、`bash · exit 0 · 1.2s`；去掉 `rawInput`、`rawOutput`、终端元数据与 DSH toolResult；保留 diff 与文件位置 |
| `DSH_ACP_TOOL_MERGE=1` | 与 summary 配合：15 秒内的连续 `execute` 调用合并为一张卡片（`bash ×3 · exit 0 · 3.7s`） |
| `DSH_ACP_TOOL_MODE=minimal` | 标题只保留工具名（兼容旧的本地补丁） |

### 4. goal 映射为 ACP plan

DSH 每会话的持久 goal 以 `goal/change` 会话事件写入日志。这里把它映射为 ACP `plan`，与 `todo/write` 产生的待办合并：

```
Goal: 整理 /tmp 下的报告文件…            (in_progress, high)
Round 0/2                                (pending, low)
盘点 /tmp 报告文件                        (待办)
清理已归档报告的原件                       (待办)
```

`paused` / `blocked` 显示为 `pending`，`completed` 显示为 `completed`，`blockedReason` 追加一行 `Blocked: …`。goal 清除时回退为 todo-only 的 plan。

## 构建与安装

仓库使用 esbuild 打包（`node build.mjs`）。本 fork 把 `prepack` 改成不依赖 npm 的写法，因此在只有 pnpm/Node 的环境里也能打包：

```bash
pnpm install          # pnpm-workspace.yaml 已允许 esbuild 等原生依赖跑构建脚本
pnpm pack             # 产出 openma-deepseek-harness-acp-<version>.tgz
dsh plugin --profile acp add file:/绝对路径/openma-deepseek-harness-acp-<version>.tgz
```

## 已知边界

- 这些开关默认保持**上游行为**（思考全文、工具全量），只有显式设置环境变量或 `DSH_ACP_TOOL_MODE` 才改变展示；回放顺序修复默认生效。
- Zed 每个会话只有一个 plan 面板，goal 与 todo 共用它；如果客户端同时使用其它写 plan 的扩展，以最后一次更新为准。
- `pnpm pack` 不再生成 `vendor/*.tgz`（runtime:pack），如需要独立 runtime 打包，请手动运行 `node scripts/pack-runtime.mjs`。
