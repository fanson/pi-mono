# 扩展功能对比: Claude Code vs Pi

> 覆盖 13 个功能维度的架构对比和借鉴分析
> 基于 Claude Code 源码 (v2.1.88+) 与 pi-mono 源码

---

## 目录

1. [LSP 集成](#1-lsp-集成)
2. [MCP 完整架构](#2-mcp-完整架构)
3. [Hooks 系统](#3-hooks-系统)
4. [Cron 定时任务](#4-cron-定时任务)
5. [Coordinator 调度](#5-coordinator-调度)
6. [Plans 系统](#6-plans-系统)
7. [Voice 语音模式](#7-voice-语音模式)
8. [MagicDocs](#8-magicdocs)
9. [Code Indexing](#9-code-indexing)
10. [Session Restore](#10-session-restore)
11. [Cost Tracker](#11-cost-tracker)
12. [Plugins 系统](#12-plugins-系统)
13. [API 错误处理](#13-api-错误处理)
14. [总结与建议](#14-总结与建议)

---

## 1. LSP 集成

### Claude Code

Claude Code 内置完整的 LSP 客户端基础设施:

```
架构:
┌───────────────────────────────────────────────────┐
│ LSPServerManager                                  │
│  ├── getAllLspServers() → config                   │
│  ├── extension → server name 映射                  │
│  ├── LSPServerInstance (per server)                │
│  │   ├── LSPClient (vscode-jsonrpc, stdio)        │
│  │   ├── subprocessEnv() 进程启动                  │
│  │   ├── crash recovery (maxRestarts: 3)           │
│  │   └── LSP_ERROR_CONTENT_MODIFIED (-32801) 重试  │
│  └── workspace/configuration handler               │
├───────────────────────────────────────────────────┤
│ 被动诊断链:                                        │
│  publishDiagnostics → LSPDiagnosticRegistry        │
│  → getLSPDiagnosticAttachments() → 下轮上下文注入   │
├───────────────────────────────────────────────────┤
│ LSPTool (主动操作):                                 │
│  goToDefinition, findReferences, hover,            │
│  symbols, callHierarchy                            │
│  MAX_LSP_FILE_SIZE_BYTES = 10MB                    │
├───────────────────────────────────────────────────┤
│ Plugin LSP:                                        │
│  lspPluginIntegration.ts → 插件可注册 LSP server    │
│  lspRecommendation.ts → 推荐安装                    │
└───────────────────────────────────────────────────┘
```

**关键常量**:
- `MAX_DIAGNOSTICS_PER_FILE = 10`
- `MAX_TOTAL_DIAGNOSTICS = 30`
- `MAX_DELIVERED_FILES = 500`
- `MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3`
- `RETRY_BASE_DELAY_MS = 500`

**诊断反馈流**: 编辑文件后, LSP server 推送 `publishDiagnostics` → 注册到 `LSPDiagnosticRegistry` → 下一轮 API 调用时作为 `type: 'diagnostics'` attachment 注入上下文。这让模型能看到编译错误并自动修复。

### Pi

**无 LSP 集成**。Pi 有 `ResourceDiagnostic` 类型用于检测 skills/prompts/themes/extensions 的加载问题, 但不是编译器/语言服务器意义上的诊断。

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 被动诊断注入 | 扩展可通过 `afterToolCall` 在 edit/write 后运行外部 linter, 将结果注入为 custom_message | 中 |
| 主动 LSP 工具 | 不建议纳入核心 — 增加大量依赖。可作为独立扩展 | — |

---

## 2. MCP 完整架构

### Claude Code

Claude Code 的 MCP 实现是生产级的, 包含完整的认证和治理体系:

```
MCP 架构:
┌────────────────────────────────────────────────────────┐
│ 连接管理                                                │
│  MCPConnectionManager.tsx (React provider)              │
│  └── useManageMCPConnections (生命周期管理)              │
│      ├── stdio/SSE/HTTP/WebSocket transports           │
│      ├── reconnect/toggle                               │
│      └── 动态配置 (.mcp.json, plugin manifests)         │
├────────────────────────────────────────────────────────┤
│ 认证                                                    │
│  auth.ts → OAuth 2.0 (MCP SDK 内置 + 本地回调)          │
│  ├── discoverAuthorizationServerMetadata                │
│  ├── authorization_code + PKCE                          │
│  ├── token refresh                                      │
│  ├── 安全存储                                            │
│  ├── AUTH_REQUEST_TIMEOUT_MS = 30s                      │
│  └── MAX_LOCK_RETRIES = 5                               │
│                                                         │
│  xaa.ts → Cross-App Access (XAA)                        │
│  ├── OAuth Protected Resource Metadata 发现             │
│  ├── JWT bearer / token exchange grants                 │
│  └── xaaIdpLogin.ts → IdP authorization_code + PKCE    │
│                                                         │
│  McpAuthTool → 伪工具, 触发 OAuth flow                   │
│  └── claudeai-proxy 特殊处理                             │
├────────────────────────────────────────────────────────┤
│ 企业策略 (config.ts)                                    │
│  isMcpServerAllowedByPolicy:                            │
│  ├── denylist 优先 (deniedMcpServers)                   │
│  ├── allowlist (name/command/URL pattern)               │
│  ├── 空 allowlist = 全部禁止                             │
│  └── SDK-type servers bypass filtering                  │
│                                                         │
│  filterMcpServersByPolicy:                              │
│  └── 批量过滤, 企业级访问控制                             │
├────────────────────────────────────────────────────────┤
│ Channel (通知通道)                                      │
│  channelNotification.ts                                 │
│  ├── getEffectiveChannelAllowlist                       │
│  ├── gateChannelServer                                  │
│  ├── org vs GrowthBook ledger                           │
│  ├── capability: experimental['claude/channel']         │
│  └── org policy channelsEnabled + session --channels    │
│                                                         │
│  channelAllowlist.ts → 独立的通道级白名单                 │
├────────────────────────────────────────────────────────┤
│ 工具集成                                                │
│  MCPTool.ts → 执行 MCP 服务器提供的工具                  │
│  └── 权限管理、结果处理、错误恢复                         │
└────────────────────────────────────────────────────────┘
```

### Pi

**无核心 MCP 客户端**。OAuth scope 字符串中提及 MCP servers (`packages/ai/src/utils/oauth/anthropic.ts`), 测试中引用了外部 `npm:pi-mcp-adapter`, 暗示社区适配器的可能性, 但不是内置功能。

### 借鉴建议

MCP 的价值在于**扩展工具生态** — 让 agent 连接外部服务 (数据库、API、文件系统)。

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| MCP 客户端基础 | 作为核心扩展或独立 package — Pi 的 provider-neutral 设计与 MCP 的 provider-neutral 协议天然契合 | 高 |
| OAuth/XAA | 过于复杂, 初期可跳过 — 先支持 stdio/SSE 的无认证 MCP server | — |
| Server policy | 可通过 settings.jsonl 实现简单的 allow/deny 列表 | 低 |

---

## 3. Hooks 系统

### Claude Code

Claude Code 拥有最完整的 hook 系统之一:

**28 种事件类型**:

```typescript
HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd',
  'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied',
  'Setup', 'TeammateIdle',
  'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged',
]
```

**3 种传输方式**:

| 传输 | 超时 | 特点 |
|------|------|------|
| Command (shell) | 10 分钟 | 主路径, 支持后台异步执行 |
| Prompt (LLM) | 30 秒 (可覆盖) | 用模型执行 hook, 返回 JSON |
| HTTP | 10 分钟 | POST JSON, URL 白名单控制 |

**聚合结果** (`AggregatedHookResult`):
- `message`: 用户可见消息
- `blockingError`: 阻止操作继续
- `permissionBehavior`: 修改权限决策
- `updatedInput`: 修改工具输入
- `additionalContexts`: 注入额外上下文
- `updatedMCPToolOutput`: 修改 MCP 工具输出
- `preventContinuation`: 阻止后续操作

**关键常量**:
- `TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000` (10 分钟)
- `SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500`
- `MAX_PENDING_EVENTS = 100`
- `ALWAYS_EMITTED_HOOK_EVENTS = ['SessionStart', 'Setup']`

### Pi

Pi 的 hook 系统分两层:

**Agent 层** (`packages/agent/src/types.ts`):
- `beforeToolCall(tool, args)` → 可修改参数或取消
- `afterToolCall(tool, args, result)` → 可修改结果

**Extension 层** (`packages/coding-agent/src/core/extensions/types.ts`):
- `ExtensionEvent` 联合类型, ~30+ 事件
- 通过 `pi.on('event', handler)` 注册
- 支持: `session_start`, `session_compact`, `session_before_compact`, `turn_start`, `turn_end`, `tool_call`, `tool_result`, `model_select` 等

### 对比

| 维度 | Claude Code | Pi |
|------|------------|-----|
| 事件数量 | 28 | ~30+ (但大部分是通知性的, 不可修改) |
| 传输方式 | 3 (command/prompt/HTTP) | 1 (进程内 TypeScript) |
| 输入修改 | `updatedInput` 可改工具参数 | `beforeToolCall` 可改参数 |
| 阻塞能力 | `blockingError` 可阻止操作 | `cancel()` 可取消特定操作 |
| 权限修改 | `permissionBehavior` 可修改权限决策 | 无 |
| 异步/后台 | 支持后台异步执行 | 无 (同步/await) |
| 信任模型 | workspace trust 检查 | 无 trust 检查 |

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 阻塞错误 | `prepareToolCall`（`packages/agent/src/agent-loop.ts`）已支持：`beforeToolCall` 可返回 `{ block: true, reason?: string }`，将跳过执行并注入错误工具结果 | — |
| HTTP hook 传输 | 不建议 — Pi 的进程内扩展已经足够灵活 | — |
| 后台异步 hook | 扩展事件已支持 async, 但无后台队列 — 可按需添加 | 中 |

---

## 4. Cron 定时任务

### Claude Code

完整的定时任务系统:

```
架构:
┌────────────────────────────────────────────────────┐
│ CronCreateTool / CronListTool / CronDeleteTool     │
│  └── MAX_JOBS = 50                                  │
├────────────────────────────────────────────────────┤
│ cronTasks.ts                                        │
│  ├── CronTask 类型                                   │
│  ├── 存储: .claude/scheduled_tasks.json              │
│  ├── durable: true → 持久化到文件                    │
│  ├── durable: false → 仅在内存/bootstrap 状态        │
│  └── jitter 防抖:                                    │
│      recurringFrac: 0.1, recurringCapMs: 15min       │
│      oneShotMaxMs: 90s, oneShotMinuteMod: 30         │
├────────────────────────────────────────────────────┤
│ cron.ts                                              │
│  ├── parseCronExpression (标准 5 字段)                │
│  ├── computeNextCronRun (本地时间, DST 感知)          │
│  └── cronToHuman (可选 UTC 显示)                     │
├────────────────────────────────────────────────────┤
│ cronScheduler.ts                                     │
│  ├── CHECK_INTERVAL_MS = 1000 (1s 轮询)             │
│  ├── FILE_STABILITY_MS = 300                         │
│  ├── chokidar 文件监视                                │
│  ├── 项目级锁 (LOCK_PROBE_INTERVAL_MS = 5000)        │
│  ├── 错过的一次性任务通知                              │
│  └── onFire(prompt) / onFireTask(task) 回调           │
├────────────────────────────────────────────────────┤
│ useScheduledTasks.ts                                 │
│  ├── REPL 集成                                       │
│  ├── agentId → teammate 路由                          │
│  └── killswitch: isKairosCronEnabled()               │
└────────────────────────────────────────────────────┘
```

### Pi

**核心无 Cron 系统**。`packages/mom` 中使用 `croner` 做周期性事件, 但那是 `mom` package 的功能, 不是 coding-agent 核心。

### 借鉴建议

Cron 对 coding agent 的价值有限 — 主要用于持续运行的 agent (CI/CD 检查、定期代码审查)。Pi 作为交互式 CLI 工具, 用户会话结束后 agent 不驻留。

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 不建议纳入核心 | 如需定时功能, 可作为 mom package 的扩展 | — |

---

## 5. Coordinator 调度

### Claude Code

两套并行的多 agent 机制:

**Coordinator Mode** (feature-gated):
```
┌───────────────────────────────────────────────┐
│ Coordinator (主线程)                           │
│  ├── 大型 system prompt 定义角色               │
│  ├── 工具: Agent, SendMessage, TaskStop        │
│  ├── Worker 工具限制 (排除内部工具)             │
│  └── 独立权限处理 (hooks → classifier → dialog)│
│                                                │
│ Workers (子线程)                                │
│  ├── <task-notification> XML 任务描述           │
│  ├── 无显式模型选择 (由 coordinator 决定)        │
│  └── 有限的工具集                               │
│                                                │
│ 与 Fork Subagent 互斥                           │
└───────────────────────────────────────────────┘
```

**Agent Swarms** (agent teams):
```
┌───────────────────────────────────────────────┐
│ Leader (主线程)                                │
│  ├── agentSwarmsEnabled() 检查                  │
│  ├── 权限桥接到 leader (leaderPermissionBridge) │
│  └── tmux/外部进程 backend                      │
│                                                │
│ Teammates (in-process or external)             │
│  ├── inProcessRunner.ts → runAgent() 包装       │
│  ├── teammateMailbox.ts → 文件通信               │
│  ├── PERMISSION_POLL_INTERVAL_MS = 500          │
│  └── SWARM_SESSION_NAME = 'claude-swarm'        │
└───────────────────────────────────────────────┘
```

**LocalAgentTask**: 异步后台 agent 的执行基底 (独立于 coordinator/swarm), 用于 `AgentTool` 派生的子任务。

### Pi

**无 coordinator/swarm**。相关能力:
- `parallel` / `sequential` 工具执行模式 (`AgentLoopConfig`)
- `handoff` 扩展示例: 创建新 session 转移上下文 (不是真正的多 agent)

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 子 agent 执行 | Pi 可通过扩展实现 — 创建新 `AgentSession` 作为子任务, 通过 `CustomEntry` 传递结果 | 高 |
| 不建议纳入核心 | 多 agent 协调增加大量复杂度, Pi 的单 agent + 扩展模型已足够 | — |

---

## 6. Plans 系统

### Claude Code

```
架构:
┌────────────────────────────────────────────────────┐
│ 存储                                                │
│  ~/.claude/plans/ (或 settings.plansDirectory)       │
│  ├── {word-slug}.md (主 session plan)                │
│  └── {word-slug}-agent-{agentId}.md (子 agent plan)  │
│  MAX_SLUG_RETRIES = 10                               │
├────────────────────────────────────────────────────┤
│ 进入 Plan Mode                                      │
│  EnterPlanModeTool → prepareContextForPlanMode       │
│  → applyPermissionUpdate → 限制工具为只读            │
│  (Kairos channels 下禁用 — 无终端交互)               │
├────────────────────────────────────────────────────┤
│ 退出 / 实施                                         │
│  ExitPlanModeV2Tool                                  │
│  ├── 读写 plan 文件                                  │
│  ├── 权限还原                                        │
│  ├── swarm/teammate 集成                             │
│  └── 用户审批流                                      │
├────────────────────────────────────────────────────┤
│ 恢复                                                 │
│  copyPlanForResume → 从消息中恢复 plan               │
│  recoverPlanFromMessages → 从 ExitPlanMode input,    │
│    planContent, plan_file_reference 中提取            │
├────────────────────────────────────────────────────┤
│ 规模控制                                             │
│  getPlanModeV2AgentCount(): 1-10 (env/tier)          │
│  getPlanModeV2ExploreAgentCount(): 默认 3            │
│  isPlanModeInterviewPhaseEnabled(): 面试阶段          │
└────────────────────────────────────────────────────┘
```

### Pi

**扩展/preset 实现**, 非核心功能:
- `examples/extensions/plan-mode/`: `/plan` 命令切换 plan 模式
- 只读工具白名单
- widget 支持
- `--plan` flag via `registerFlag`
- preset 系统文档提及 plan/implement 预设

### 对比

| 维度 | Claude Code | Pi |
|------|------------|-----|
| 核心/扩展 | 核心功能 (内置工具) | 扩展示例 |
| 持久化 | 专用 plan 文件 + 恢复机制 | 无专用存储 |
| 多 agent | V2 支持多 agent 执行 plan | 单 agent |
| 审批流 | 用户审批 → 实施 | 无 |

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| Plan 持久化 | 扩展可用 `CustomEntry` 存储 plan 到 session | 低 |
| Plan 恢复 | 在 `session_start` (resume) 时从 session 恢复 plan | 中 |

---

## 7. Voice 语音模式

### Claude Code

```
架构:
┌────────────────────────────────────────────────────┐
│ 录音                                                │
│  voice.ts → SoX/arecord                             │
│  RECORDING_SAMPLE_RATE = 16000, mono                │
│  SILENCE_DURATION_SECS = '2.0'                      │
│  SILENCE_THRESHOLD = '3%'                           │
├────────────────────────────────────────────────────┤
│ STT (Speech-to-Text)                                │
│  voiceStreamSTT.ts → WebSocket                      │
│  ├── 端点: /api/ws/speech_to_text/voice_stream      │
│  ├── OAuth Bearer 认证                               │
│  ├── linear16 16kHz mono                             │
│  ├── KEEPALIVE_INTERVAL_MS = 8000                    │
│  ├── Deepgram Nova 3 (可选, via cobalt_frost)        │
│  ├── endpointing_ms: 300                             │
│  ├── utterance_end_ms: 1000                          │
│  └── FINALIZE_TIMEOUTS: noData=1500ms, safety=5000ms │
├────────────────────────────────────────────────────┤
│ 交互                                                │
│  useVoice.ts → hold-to-talk React hook               │
│  ├── 语言映射 (DEFAULT_STT_LANGUAGE = 'en')           │
│  ├── keyterm boosting (voiceKeyterms.ts)              │
│  └── 自动重复行为                                     │
├────────────────────────────────────────────────────┤
│ 门控                                                 │
│  feature('VOICE_MODE') + GrowthBook killswitch       │
│  + Anthropic OAuth with access token                  │
└────────────────────────────────────────────────────┘
```

### Pi

**无语音模式**。Pi 是纯文本 CLI 交互。

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 不建议 | 语音模式需要 STT 服务端支持, 与 Pi 的 CLI/provider-neutral 设计不匹配 | — |

---

## 8. MagicDocs

### Claude Code

```
架构 (仅限 ant 内部构建):
┌────────────────────────────────────────────────────┐
│ 检测                                                │
│  detectMagicDocHeader(): 匹配 "# MAGIC DOC: [title]"│
│  可选: 标题下紧跟的斜体行作为 instructions            │
├────────────────────────────────────────────────────┤
│ 注册与追踪                                          │
│  registerFileReadListener → 读取文件时检测            │
│  trackedMagicDocs (Map) 追踪已注册的 magic doc        │
├────────────────────────────────────────────────────┤
│ 自动更新                                            │
│  registerPostSamplingHook(updateMagicDocs)           │
│  条件: 主线程 + 最后一轮无工具调用 ("空闲")            │
│  执行: 用 magic-docs subagent 更新文件               │
│  ├── model: 'sonnet'                                │
│  ├── tools: [FILE_EDIT_TOOL_NAME] only              │
│  └── 自定义 prompt: ~/.claude/magic-docs/prompt.md   │
│      模板变量: {{docContents}}, {{docPath}}, etc.    │
├────────────────────────────────────────────────────┤
│ 门控                                                 │
│  USER_TYPE === 'ant' (仅内部用户)                    │
└────────────────────────────────────────────────────┘
```

### Pi

**无 MagicDocs**。Pi 加载 `AGENTS.md` / `CLAUDE.md` 作为项目上下文, 但这是静态文件包含, 不自动维护。

### 借鉴建议

MagicDocs 的核心思想 — "agent 自动维护某些文档" — 有价值, 但实现为内部功能说明其成熟度有限。

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| Auto-update docs 扩展 | 扩展可在 `turn_end` 事件中检测特定格式的文件, 用工具自动更新 | 中 |

---

## 9. Code Indexing

### Claude Code

**没有内置的嵌入/向量索引**。`codeIndexing.ts` 是**遥测工具** — 检测用户是否使用了第三方代码索引工具 (Sourcegraph、Cody、hound 等) 并记录分析事件。

有一个**文件模糊搜索**模块 (`native-ts/file-index/index.ts`): 基于 nucleo 评分算法的路径匹配, 用于快速文件选择 UI, 不是语义搜索。

常量: `MAX_QUERY_LEN = 64`, `CHUNK_MS = 4`, test-file penalty `1.05`.

### Pi

**无代码索引**。依赖 Read/Grep/Find/Ls 工具做文件系统级搜索。

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 模糊文件搜索 | 可作为独立工具 — 但 grep/glob 已经覆盖大部分场景 | 低 |
| 语义索引 | 不建议 — 需要嵌入模型和向量存储, 与 Pi 的轻量哲学冲突 | — |

---

## 10. Session Restore

### Claude Code

```
核心恢复流 (sessionRestore.ts):
┌────────────────────────────────────────────────────┐
│ processResumedConversation():                       │
│  ├── switchSession(sessionId) → 切换 session 指针   │
│  ├── renameRecordingForSession()                    │
│  ├── resetSessionFilePointer()                      │
│  ├── restoreCostStateForSession(id) → 费用恢复      │
│  ├── worktree cd → 切换到正确的工作目录               │
│  ├── coordinator mode 恢复                           │
│  ├── context-collapse 恢复                           │
│  ├── contentReplacements (fork vs copy)              │
│  └── agent 恢复                                      │
├────────────────────────────────────────────────────┤
│ Bridge (远程模式):                                    │
│  useReplBridge.tsx                                    │
│  ├── flushedUUIDsRef → 防重复消息                     │
│  ├── BRIDGE_FAILURE_DISMISS_MS = 10_000               │
│  ├── MAX_CONSECUTIVE_INIT_FAILURES = 3                │
│  └── api.reconnectSession() → 重连                    │
├────────────────────────────────────────────────────┤
│ Teleport (远程恢复):                                  │
│  teleport.tsx → 从远程 transcript 恢复到本地           │
├────────────────────────────────────────────────────┤
│ SessionStart hooks:                                   │
│  resume/continue 时条件触发, 避免双重触发              │
├────────────────────────────────────────────────────┤
│ 持久化:                                               │
│  sessionStorage.ts → JSONL transcript                 │
│  adoptResumedSessionFile, restoreSessionMetadata      │
└────────────────────────────────────────────────────┘
```

### Pi

Pi 有完整的 session restore:
- `SessionManager` (`session-manager.ts`): append-only JSONL, 版本化 (v3)
- `--resume` / `-r` CLI 参数 (`args.ts`)
- `session-picker.ts`: 交互式选择历史 session
- `AgentSessionRuntime` (`agent-session-runtime.ts`): 闭包工厂模式管理 `/new`, `/resume`, `/fork`, `/switchSession` 命令
- `session_start` 事件带 `reason` 字段 (startup/reload/new/resume/fork)
- 扩展可通过 `CustomEntry` 持久化状态

### 对比

| 维度 | Claude Code | Pi |
|------|------------|-----|
| 基本恢复 | ✔ | ✔ |
| 费用恢复 | ✔ restoreCostStateForSession | ✔ session 中有 usage 记录 |
| 工作目录 | ✔ worktree cd | ✔ session header 记录 cwd |
| 远程恢复 | ✔ bridge reconnect + teleport | ✘ 无远程模式 |
| 防重复 | ✔ flushedUUIDsRef | ✘ 无 (单进程) |
| 分支恢复 | 通过 forked session | ✔ 原生树形结构 + fork |

Pi 的 session restore 在本地模式下已经相当完整, 树形结构甚至比 Claude Code 更灵活。

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 费用恢复 | Pi 的 footer 已聚合 usage, 但 resume 后可能丢失 — 应从 session entries 重算 | 低 |

---

## 11. Cost Tracker

### Claude Code

```
定价模型 (modelCost.ts):
┌────────────────────────────────────────────────────┐
│ MODEL_COSTS 映射:                                    │
│  inputTokens: $/Mtok                                │
│  outputTokens: $/Mtok                               │
│  promptCacheWriteTokens: $/Mtok                     │
│  promptCacheReadTokens: $/Mtok                      │
│  webSearchRequests: $/request                        │
│                                                      │
│ 示例 (COST_TIER_3_15):                               │
│  input=3, output=15, cacheWrite=3.75, cacheRead=0.3  │
│  webSearch=0.01                                       │
├────────────────────────────────────────────────────┤
│ 实时累计 (cost-tracker.ts):                          │
│  addToTotalSessionCost(cost, usage, model)            │
│  ├── per-model usage 累计                             │
│  ├── advisor usage 递归累计                            │
│  └── 总费用 state 更新                                 │
│                                                      │
│ 持久化:                                               │
│  saveCurrentSessionCosts() → project config           │
│  restoreCostStateForSession() → resume 时恢复          │
│                                                      │
│ 显示:                                                 │
│  formatTotalCost() → USD + 时长 + lines changed       │
│  /cost 命令 → subscriber 显示订阅消息                  │
│  formatCost: $0.5 以上显示 2 位小数                    │
├────────────────────────────────────────────────────┤
│ 可见性控制 (billing.ts):                              │
│  hasConsoleBillingAccess()                            │
│  DISABLE_COST_WARNINGS                                │
│  role-based 控制                                      │
└────────────────────────────────────────────────────┘
```

### Pi

Pi 有 token 级别的费用追踪:
- `Usage` 类型 (`packages/ai/src/types.ts`): `cost: { input, output, cacheRead, cacheWrite, total }`
- Footer 显示聚合 usage 和 cost (`packages/coding-agent/src/modes/interactive/components/footer.ts`)
- Session 总计在 `agent-session.ts` 中累积
- Model registry 包含定价元数据 (`model-registry.ts`)

### 对比

| 维度 | Claude Code | Pi |
|------|------------|-----|
| 定价精度 | 详细的 per-model $/Mtok | ✔ 模型注册表含定价 |
| 实时累计 | ✔ per-API-call 累计 | ✔ per-turn 累计 |
| 持久化 | ✔ project config | 部分 (session 内) |
| Resume 恢复 | ✔ restoreCostStateForSession | 需验证 |
| Advisor 递归 | ✔ 子模型费用递归累计 | ✘ |
| Web search 费用 | ✔ | ✘ |
| 可见性控制 | ✔ subscriber/role 差异化 | ✘ |
| /cost 命令 | ✔ | 无专用命令, footer 显示 |

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| Resume 费用恢复 | 从 session entries 的 usage 累计恢复 | 低 |
| /cost 命令 | 作为内置命令, 显示详细的 per-model 费用分解 | 低 |

---

## 12. Plugins 系统

### Claude Code

```
架构:
┌────────────────────────────────────────────────────┐
│ 声明层 (settings)                                    │
│  extraKnownMarketplaces → 市场源                     │
│  enabledPlugins → "plugin@marketplace" 格式           │
│  allowedMarketplaces / deniedMarketplaces → 策略      │
├────────────────────────────────────────────────────┤
│ 物化层 (磁盘)                                        │
│  ~/.claude/plugins/known_marketplaces.json            │
│  ~/.claude/plugins/marketplaces/ → 缓存               │
│  ~/.claude/plugins/cache/ → 安装的插件                 │
├────────────────────────────────────────────────────┤
│ Reconciler (reconciler.ts)                           │
│  diff 声明意图 vs 物化状态                              │
│  → 安装/更新/删除                                      │
│  git worktree 规范化 (memoized)                       │
├────────────────────────────────────────────────────┤
│ 安装 (marketplaceManager.ts)                         │
│  ├── git clone (shallow, sparse checkout)             │
│  ├── DEFAULT_PLUGIN_GIT_TIMEOUT_MS = 120s             │
│  ├── GIT_TERMINAL_PROMPT=0 (非交互)                   │
│  ├── StrictHostKeyChecking=yes (fail closed)          │
│  └── credential 日志脱敏                               │
├────────────────────────────────────────────────────┤
│ Manifest (plugin.json, schemas.ts)                    │
│  PluginManifestSchema (Zod 验证)                      │
│  包含: commands, agents, skills, hooks, MCP, LSP      │
├────────────────────────────────────────────────────┤
│ 来源类型 (MarketplaceSourceSchema):                   │
│  url, github, git, npm, local paths                   │
├────────────────────────────────────────────────────┤
│ Loader (pluginLoader.ts)                              │
│  marketplace-first → builtins → --plugin-dir           │
│  加载: commands/agents/skills/hooks/MCP/LSP            │
├────────────────────────────────────────────────────┤
│ 后台安装 (PluginInstallationManager.ts)               │
│  启动时后台 reconcile + refresh                        │
├────────────────────────────────────────────────────┤
│ UI (commands/plugin/)                                  │
│  ManagePlugins, DiscoverPlugins, BrowseMarketplace     │
│  AddMarketplace                                        │
├────────────────────────────────────────────────────┤
│ 企业策略                                               │
│  allow/block lists → PluginError: marketplace-blocked  │
└────────────────────────────────────────────────────┘
```

### Pi

Pi 的扩展系统:

```
核心:
  packages/coding-agent/src/core/extensions/
  ├── types.ts → ExtensionAPI, ExtensionEvent
  ├── loader.ts → loadExtensions, loadExtension, loadExtensionModule
  ├── runner.ts → ExtensionRunner (事件分发)
  └── wrapper.ts → 安全包装

安装 (包管理器):
  settings-manager.ts → getPackages() → 外部 npm/git 包
  package-manager.ts → DefaultPackageManager
  └── npm install 到 extensions 目录

示例扩展:
  examples/extensions/ → plan-mode, handoff, preset, etc.
```

### 对比

| 维度 | Claude Code | Pi |
|------|------------|-----|
| 安装来源 | git, npm, url, github, local | npm, git, local |
| 市场 | ✔ 中心化 marketplace + 发现 UI | ✘ 无市场 |
| Manifest | plugin.json (Zod 验证) | package.json 或文件约定 |
| 隔离 | git clone + cache 目录 | npm install 到 extensions/ |
| 企业策略 | ✔ allow/deny list | ✘ |
| 加载内容 | commands, agents, skills, hooks, MCP, LSP | TypeScript 模块 (事件处理器) |
| 后台安装 | ✔ 启动时 reconcile | ✘ 首次使用时安装 |
| 安全 | StrictHostKeyChecking=yes, credential 脱敏 | 基本的 npm install |

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| Manifest 验证 | 扩展可定义 `extension.json` 描述元数据, 加载时验证 | 低 |
| 安全安装 | git clone 时 `GIT_TERMINAL_PROMPT=0` + `StrictHostKeyChecking=yes` | 低 |

---

## 13. API 错误处理

### Claude Code

```
重试架构 (withRetry.ts):
┌────────────────────────────────────────────────────┐
│ withRetry<T>() — AsyncGenerator                     │
│  ├── 每次重试 yield SystemAPIErrorMessage            │
│  ├── DEFAULT_MAX_RETRIES = 10                        │
│  ├── BASE_DELAY_MS = 500 (指数退避)                  │
│  ├── 退避上限: 32s (默认), 5min (unattended)          │
│  └── 失败时: CannotRetryError / FallbackTriggeredError│
├────────────────────────────────────────────────────┤
│ 错误分类:                                            │
│  429 (Rate Limit):                                    │
│  ├── subscriber vs non-subscriber 差异处理            │
│  ├── unified rate-limit headers 解析                  │
│  ├── JSON body fallback (无 header 时)                │
│  └── fast mode: 冷却 + 禁用 fast mode                │
│                                                      │
│  529 (Overloaded):                                    │
│  ├── 仅前台 QuerySource 重试                          │
│  │   FOREGROUND_529_RETRY_SOURCES:                    │
│  │   repl_main_thread, sdk, task_tool, agent_tool...  │
│  ├── MAX_529_RETRIES = 3                              │
│  ├── 3次后: FallbackTriggeredError → 切换模型          │
│  └── 外部用户: CannotRetryError + 提示切换模型          │
│                                                      │
│  401 (Auth):                                          │
│  ├── OAuth token refresh                              │
│  ├── clearApiKeyHelperCache                           │
│  ├── Bedrock/Vertex credential 缓存清除               │
│  └── 可选 disableKeepAlive (GrowthBook)               │
│                                                      │
│  5xx: 标准指数退避重试                                  │
├────────────────────────────────────────────────────┤
│ Unattended/Persistent 模式:                          │
│  feature('UNATTENDED_RETRY')                          │
│  ├── PERSISTENT_MAX_BACKOFF_MS = 5min                 │
│  ├── PERSISTENT_RESET_CAP_MS = 6hr                    │
│  ├── 分块 sleep + heartbeat yields                    │
│  └── 适用于 CI/CD 等无人值守场景                       │
├────────────────────────────────────────────────────┤
│ 用户消息映射 (errors.ts):                             │
│  getAssistantMessageFromError() →                     │
│  rate_limit, auth, PDF, image, tool_use, etc.         │
│                                                      │
│ 连接错误格式化 (errorUtils.ts):                       │
│  formatAPIError() → SSL codes, HTML 清洗,              │
│  嵌套 Bedrock/Anthropic 错误提取                       │
├────────────────────────────────────────────────────┤
│ Fast Mode 交互:                                       │
│  429/529 + fast mode → 短等待 or 冷却 + 禁用           │
│  SHORT_RETRY_THRESHOLD_MS = 20_000                    │
│  MIN_COOLDOWN_MS = 10min                              │
│  DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30min           │
│  FLOOR_OUTPUT_TOKENS = 3000                           │
└────────────────────────────────────────────────────┘
```

### Pi

Pi 的错误处理分两层:

**pi-ai 层** (`packages/ai/src/`):
- `StreamOptions.maxRetryDelayMs`: 最大重试延迟
- 各 provider 在 stream 实现中处理重试 (provider-specific)
- `overflow.ts`: 区分 context overflow vs 其他错误
- `AssistantMessageEvent.error`: 错误事件类型

**coding-agent 层** (`packages/coding-agent/src/core/agent-session.ts`):
- 自动重试: `auto_retry_start` / `auto_retry_end` 事件
- Overflow recovery: 触发 compaction 后重试
- `_overflowRecoveryAttempted`: 防止死循环

### 对比

| 维度 | Claude Code | Pi |
|------|------------|-----|
| 重试策略 | 统一的 `withRetry` + AsyncGenerator | per-provider + agent-session 层 |
| 最大重试次数 | 10 (默认), 可配置 | provider 依赖 |
| 退避 | 指数退避, base=500ms, cap=32s | `maxRetryDelayMs` |
| 529 处理 | 前台/后台差异化 + model fallback | 无 529 特殊处理 |
| 429 处理 | subscriber 差异 + unified headers | provider 级别处理 |
| 401 处理 | token refresh + credential 缓存清除 | provider 级别处理 |
| Unattended 模式 | ✔ 长退避 (5min) + heartbeat | ✘ |
| 熔断器 | auto-compact 3 次失败停止 | ✘ |
| 错误消息映射 | 详细的用户友好消息 | stopReason='error' + errorMessage |
| 连接错误 | SSL code 映射 + HTML 清洗 | 基本错误透传 |

### 借鉴建议

| 建议 | 适合 Pi 的方式 | 难度 |
|------|-------------|------|
| 统一重试层 | pi-ai 层添加 provider-neutral 的重试包装器, 指数退避 + 可配置上限 | 中 |
| Overflow 自动恢复 | Pi 已有, 但缺少熔断器 — 添加连续失败计数 | 低 |
| 用户友好错误消息 | 将常见 API 错误映射为可读消息 (而非原始错误) | 低 |

---

## 14. 总结与建议

### 功能存在性矩阵

| # | 功能 | Claude Code | Pi | 差距 |
|---|------|------------|-----|------|
| 1 | LSP 集成 | ✔ 完整 | ✘ | 大 |
| 2 | MCP | ✔ 完整 (OAuth, XAA, policy) | ✘ | 大 |
| 3 | Hooks | ✔ 28 事件, 3 传输 | ✔ 30+ 事件, 进程内 | 中 (传输/聚合差异) |
| 4 | Cron | ✔ 完整 | ✘ (mom package) | 大 (但价值有限) |
| 5 | Coordinator | ✔ 两套机制 | ✘ | 大 |
| 6 | Plans | ✔ 核心功能 | ✔ 扩展示例 | 中 |
| 7 | Voice | ✔ | ✘ | 大 (但不适合 Pi) |
| 8 | MagicDocs | ✔ (ant-only) | ✘ | 中 |
| 9 | Code Indexing | ✘ (仅遥测) | ✘ | 无 |
| 10 | Session Restore | ✔ | ✔ | 小 (远程恢复差异) |
| 11 | Cost Tracker | ✔ | ✔ | 小 (持久化/resume 差异) |
| 12 | Plugins | ✔ marketplace + policy | ✔ 扩展 + 包管理 | 中 (市场/策略差异) |
| 13 | API 错误处理 | ✔ 统一 + 详细 | ✔ 分层但基础 | 中 |

### 按 Pi 哲学的优先级建议

**适合纳入核心 (高 ROI)**:

1. **统一重试层** — pi-ai 层添加 provider-neutral 重试逻辑, 指数退避, 可配置上限
2. **用户友好错误消息** — 常见 API 错误的可读映射
3. **熔断器** — overflow/compact 连续失败后停止重试
4. **Resume 费用恢复** — 从 session entries 重算累计费用

**适合作为扩展实现**:

5. **LSP 诊断注入扩展** — afterToolCall 时运行 linter, 注入结果
6. **MCP 基础客户端扩展** — stdio/SSE 传输, 无需 OAuth
7. **Plan 持久化扩展** — 用 CustomEntry 存储和恢复 plan
8. **Auto-update docs 扩展** — turn_end 时更新特定格式的文件

**不建议纳入 (与 Pi 设计不符)**:

- Voice — 需要 STT 服务端, 非 CLI 场景
- Cron — Pi 不驻留, 定时任务需外部触发
- Coordinator/Swarm — 增加大量复杂度, Pi 的单 agent + 扩展足够
- MagicDocs — Claude Code 自己也限制为 ant-only, 未完全成熟
- Plugin marketplace — Pi 的包管理器 + npm/git 已足够
- OAuth/XAA — 过于复杂, 可后续按需添加
