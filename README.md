# deepseek-harness-acp-zed

面向 [Zed](https://zed.dev) 的 DeepSeek Harness ACP 适配器，fork 自
[`openma-ai/deepseek-harness-acp`](https://github.com/openma-ai/deepseek-harness-acp)。

本项目把日常在 Zed 里使用 DSH（DeepSeek Harness）时遇到的兼容性与展示问题
直接修在**源码层**，不再对发布产物做 dist 补丁。除下方列出的差异外，其余行为
与上游保持一致；上游完整文档见 [`README.upstream.md`](./README.upstream.md)。

- 上游版本基线：`0.4.41`
- 本 fork 版本：`0.4.41-zed.1`
- 包名：`deepseek-harness-acp-zed`（**与上游包名不同**，避免 profile 依赖混淆）

## 为什么会有这个 fork

Zed 作为 ACP 客户端有几处与 DSH 上游假设不一致的地方：

1. **恢复线程没有历史**：Zed 只在收到 `session/load` 响应之后才登记会话，
   而上游在响应前就同步回放历史，先到的 `session/update` 全被当作“未知会话”丢弃。
2. **思考内容太吵**：Zed 的 Thinking 区域会展开推理全文，包括模型自己写的命令草稿。
3. **工具卡片太吵**：每个 `bash` 调用都展示命令原文和完整输出。
4. **goal 不可见**：DSH 每会话的持久 goal 在 Zed 里没有任何展示位。

## 与上游的差异

### 1. `session/load` 回放改到响应之后

- `src/bridge/replay-queue.ts`：回放闭包入队；
- `src/bridge/index.ts`：`restoreSession` 改用 `replayAfterResponse(...)`；
- `src/stdio.ts`：写出响应帧（有 `id`、无 `method`）后调用 `flushReplays()`。

判定依据是“响应字节已经写出”，与耗时无关：会话再大（实测有 39.9 秒才返回的
14 轮会话），回放也紧贴响应之后，不会被客户端丢弃。

### 2. 思考块可控

| 环境变量 | 行为 |
|---|---|
| 不设置 | 不发送 `agent_thought_chunk` |
| `DSH_ACP_THOUGHT_PREVIEW=<n>` | 每条消息最多发送前 n 个字符 |
| `DSH_ACP_SHOW_THOUGHTS=1` | 发送全文，由客户端自行折叠 |

### 3. 工具卡片详略

| 环境变量 | 行为 |
|---|---|
| 不设置 | 原样发送（命令原文、输出、终端元数据） |
| `DSH_ACP_TOOL_MODE=summary` | 标题为 `read · 文件名`、`bash · exit 0 · 1.2s`；去掉 `rawInput`、`rawOutput`、终端元数据与 DSH toolResult；保留 diff 与文件位置 |
| `DSH_ACP_TOOL_MERGE=1` | 与 summary 配合：15 秒内的连续 `execute` 调用合并为 `bash ×3 · exit 0 · 3.7s` |
| `DSH_ACP_TOOL_MODE=minimal` | 标题只保留工具名 |

### 4. goal 映射为 ACP plan

DSH 的持久 goal 以 `goal/change` 会话事件写入日志；这里把它映射为 ACP `plan`，
与 `todo/write` 的待办合并显示：

```
Goal: 整理 /tmp 下的报告文件…        (in_progress, high)
Round 0/2                            (pending, low)
盘点 /tmp 报告文件                    (待办)
清理已归档报告的原件                   (待办)
```

`paused` / `blocked` 显示为 `pending`，`completed` 显示为 `completed`，
`blockedReason` 追加一行 `Blocked: …`；goal 清除时回退为 todo-only 的 plan。

### 5. 构建方式

`prepack` 改为不依赖 npm（`node build.mjs`），并附带 `pnpm-workspace.yaml`
允许 esbuild、node-pty 等原生依赖执行构建脚本，因此在只有 pnpm/Node 的环境里
也能打包。

## 安装

```bash
pnpm install
node build.mjs
pnpm pack --pack-destination ./artifacts

dsh plugin --profile acp add "file:/绝对路径/artifacts/deepseek-harness-acp-zed-0.4.41-zed.1.tgz"
```

更新已安装的版本时，请先 `dsh plugin --profile acp remove deepseek-harness-acp-zed`
再 add 新 tarball：旧 spec 指向的 tarball 一旦被删，pnpm 会解析失败。

## 目录结构

| 路径 | 说明 |
|---|---|
| `src/` | TypeScript 源码（`bridge/`、`multi-root/` 与顶层入口） |
| `src/bridge/replay-queue.ts` | 回放队列（本 fork 新增） |
| `src/bridge/tool-presenter.ts` | 工具卡片详略过滤（本 fork 新增） |
| `cordis.patch.yml` | profile 组合补丁（行名已改为 `deepseek-harness-acp-zed/*`） |
| `dist/` | `node build.mjs` 的产物（打包时包含） |
| `docs/zed.md` | Zed 集成说明（与本文档内容对应） |
| `test/` | vitest 测试 |

## 同步上游

```bash
git fetch upstream
git rebase upstream/main        # 冲突主要集中在 cordis.patch.yml 的包名行
pnpm install
node build.mjs && pnpm pack --pack-destination ./artifacts
```

## 许可

沿用上游许可证，见 [`LICENSE`](./LICENSE)。本 fork 只做 Zed 兼容性调整，
不改变 DSH 本体的行为与协议语义。
