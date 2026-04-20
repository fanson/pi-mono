# Claude Code vs Pi-Mono 深度架构对比与借鉴建议

> 基于 claude-reviews-claude (Claude Code v2.1.88 架构文档) 与 pi-mono 源码的系统性对比分析
> 日期: 2026-04-01

---

## 目录

1. [QueryEngine / 查询引擎](#1-queryengine--查询引擎)
2. [工具系统 (Tool System)](#2-工具系统-tool-system)
3. [多Agent协调 (Multi-Agent Coordination)](#3-多agent协调-multi-agent-coordination)
4. [扩展能力 (Plugin, MCP, Skill)](#4-扩展能力-plugin-mcp-skill)
5. [Hook系统](#5-hook系统)
6. [Bash引擎](#6-bash引擎)
7. [权限系统 (Permission System)](#7-权限系统-permission-system)
8. [Agent集群 (Agent Swarms)](#8-agent集群-agent-swarms)
9. [会话管理 (Session Management)](#9-会话管理-session-management)
10. [上下文组装 (Context Assembly)](#10-上下文组装-context-assembly)
11. [Compaction (上下文压缩)](#11-compaction-上下文压缩)
12. [Prompt Cache (提示缓存)](#12-prompt-cache-提示缓存)
13. [状态管理 (State Management)](#13-状态管理-state-management)
14. [Memory (跨会话记忆)](#14-memory-跨会话记忆)
15. [启动与Bootstrap](#15-启动与bootstrap)
16. [Bridge系统 (远程控制)](#16-bridge系统-远程控制)
17. [遥测、隐私与运维控制](#17-遥测隐私与运维控制)
18. [PR建议优先级](#18-pr建议优先级)

---

## 1. QueryEngine / 查询引擎

### Claude Code 设计

Claude Code 采用**两层分离**架构:

- **`QueryEngine`** (会话级): 持有 `mutableMessages`, `totalUsage`, `readFileState`(文件缓存), `abortController`, `permissionDenials`, `discoveredSkillNames`。入口 `submitMessage()` 返回 `AsyncGenerator<SDKMessage>`。
- **`query()`** (单轮级): `while (true)` 循环: 流式API → 遇到 `tool_use` 执行工具 → push结果 → 继续直到 `end_turn` 或达到限制。

**关键设计决策:**
- AsyncGenerator 作为**唯一IPC路径** — 所有消息类型通过一个 `yield` 管道，提供背压、类型安全和取消语义
- **Pre-API 5阶段压缩管线** (严格有序): (1) Tool result budget → (2) Snip (`HISTORY_SNIP`) → (3) Microcompact (`CACHED_MICROCOMPACT`) → (4) Context collapse (`CONTEXT_COLLAPSE`) → (5) Autocompact → API调用
- **90s SSE流空闲看门狗** — 检测**SSE流数据停滞** (非整个查询循环)，数据到达时重置计时器
- **前台/后台分离的重试策略** — 529 错误仅对 `FOREGROUND_529_RETRY_SOURCES` 重试; 429 回退 base 500ms, max 32s; `UNATTENDED_RETRY` 心跳以 30s 块分割, 最大 5min 回退
- **水印式错误作用域** — `getInMemoryErrors()` + 水印切片，轮次范围的错误管理
- **Fallback tombstoning**: `FallbackTriggeredError` (3次连续529) → 为每个孤立assistant消息 yield `tombstone`, 清除 thinking 签名, 设置 `attemptWithFallback`
- **Raw SSE 而非 SDK stream** — 避免 SDK 每个 delta 重建完整消息导致的 O(n²) 字符串开销
- **消息不可变性** — `normalizeMessagesForAPI()` + clone-before-yield, API 消息字节稳定以保护 prompt cache
- **Git 上下文**: `--no-optional-locks`, 状态截断 2,000 字符, trust-gated (不信任的工作区不运行 git hooks)

### Pi 当前设计

Pi 采用**三层架构**:
- **`streamSimple`** (pi-ai): HTTP/provider流式传输
- **`runAgentLoop`** (agent-core): 轮次循环、工具执行、事件
- **`AgentSession.prompt()`** (coding-agent): CLI/TUI, 会话文件, 扩展集成

**当前局限:**
- 没有独立的 QueryEngine 抽象 — 行为分散在 `Agent`, `AgentSession`, 和 providers 之间
- 没有 pre-API 压缩管线 (microcompact 等)
- 缺少流空闲看门狗
- 缺少前台/后台分离的重试策略

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| Pre-API 上下文管线 | 中 | 高 | 在发送API前增加有序的压缩/裁剪管线 |
| 流空闲看门狗 | 低 | 中 | 超时检测挂起的SSE流 |
| AsyncGenerator 统一消息管道 | 高 | 高 | 统一事件流，提供背压和取消 |
| 前台/后台重试策略 | 低 | 中 | 区分前台交互 vs 后台任务的重试行为 |
| 水印错误切分 | 低 | 低 | 用引用标记而非计数来管理错误范围 |

---

## 2. 工具系统 (Tool System)

### Claude Code 设计

- **`Tool<Input, Output, Progress>`** 统一接口: name, Zod inputSchema, `call()`, 权限钩子, 并发/只读标志, React UI渲染器
- **`buildTool()` 保守默认值**: `isConcurrencySafe: false`, `isReadOnly: false` → **fail-closed**: 忘记设标志就自动序列化执行
- **Flat registry array** + 多层过滤: deny rules → `isEnabled()` → mode filter → `assembleToolPool()` + MCP
- **分区排序 (prompt cache)**: 内置工具作为 **prefix**，MCP工具作为 **suffix** — MCP变动不会使内置工具缓存失效
- **ToolSearch / `shouldDefer`**: 大MCP工具集的延迟加载
- **StreamingToolExecutor**: 可在模型流仍在进行时**开始执行工具** (流式工具执行), 构造时接收 tools + `canUseTool` + `toolUseContext`
- **13步执行管线**: (1) find tool → (2) abort check → (3) `streamedCheckPermissionsAndCallTool` → (4) Zod validate → (5) `validateInput` → (6) Bash speculative classifier → (7) PreToolUse hooks → (8) `canUseTool` → (9) `call` → (10) PostToolUse hooks → (11) `mapToolResultToToolResultBlockParam` → (12) `processToolResultBlock` (大结果 → `~/.claude/tool-results/`) → (13) contextModifier + newMessages
- **文件工具增强**: `FileStateCache` + 写前验证(mtime/content), 读去重 (`file_unchanged`), 危险路径阻断, 8步edit验证
- **工具结果大小限制**: Bash 30,000 chars; FileEdit/Glob/Grep 100,000 chars; FileRead 无限制但有单独限制
- **Glob**: 默认 100 文件, 按 mtime 排序; **Grep**: 250 matches (`head_limit`) + 分页
- **Simple 模式**: 只有 Bash + FileRead + FileEdit (+ coordinator extras)
- **`contextModifier`**: 仅在 `isConcurrencySafe() === false` 时应用 — 避免并发工具竞态修改共享状态

### Pi 当前设计

- **`AgentTool`** (pi-agent-core): name, TypeBox schema, `execute`, 可选 `prepareArguments`
- **`ToolDefinition`** (extensions): 更丰富的元数据用于UI + 扩展包装
- 执行模式: 只有全局 `sequential` / `parallel` 开关；没有 per-tool `executionMode`
- 无内置权限管线 — 通过 hooks + 工具实现
- 无延迟工具加载

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **工具并发安全标志** | 中 | 高 | 每工具 `isConcurrencySafe` + `isReadOnly` 标志，支持分区批次执行 |
| **fail-closed 默认值** | 低 | 高 | 默认序列化执行，显式标记可并发工具 |
| **工具排序策略** | 低 | 中 | 内置工具 prefix + 扩展工具 suffix，保护 prompt cache |
| **延迟工具加载** | 中 | 中 | 大工具集的 `shouldDefer` + `ToolSearch` 模式 |
| **流式工具执行** | 高 | 高 | 在assistant消息流完成前就开始解析和执行工具 (已在 issue #5 中标记为设计选择) |
| **读去重** | 低 | 中 | 连续读同一文件时返回 `file_unchanged` 存根 (issue #8) |
| **写前验证** | 中 | 中 | edit前检查 mtime/hash (issue #11) |
| **工具结果大小限制** | 低 | 中 | per-tool `maxResultSizeChars` + 超大结果写磁盘 |

---

## 3. 多Agent协调 (Multi-Agent Coordination)

### Claude Code 设计

Claude Code 有两种多agent模式:

**Coordinator模式:**
- 编译时特性门控 + 运行时环境变量 (`COORDINATOR_MODE`)
- Coordinator **不能使用** file/bash 工具 — 强制委托
- Workers 不共享 coordinator 对话 — 提示必须自包含
- 完成结果作为 `<task-notification>` XML 用户角色消息返回
- Scratchpad 目录 (特性门控): 跨worker的共享文件系统
- Fork子agent (可选): 继承父上下文/缓存

**Swarm/Team模式:**
- 文件系统邮箱 (`~/.claude/teams/{team}/inboxes/{name}.json`)
- Leader 生成 teammates, 通过 CLI 参数传递策略
- 非交互式 workers 通过邮箱**委托权限**给 leader
- Backend 抽象: tmux > iTerm2 > in-process

### Pi 当前设计

- **同会话**: steer/follow-up 队列实现中断式通信
- **多agent**: 仅通过**外部进程** (examples/extensions/subagent)
- **没有**内置team/邮箱/集群API

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **SubAgent 工具 (内置)** | 高 | 极高 | 一等公民的子agent工具，继承上下文 |
| **Coordinator模式** | 极高 | 高 | 编排agent只负责分配，worker执行实际工作 |
| **结构化完成通知** | 中 | 高 | 子agent结果作为XML标记的用户消息返回 |
| **Team邮箱** | 极高 | 中 | 文件系统邮箱实现多进程agent通信 |
| **权限委托协议** | 高 | 高 | 非交互式worker向leader委托权限决策 |

---

## 4. 扩展能力 (Plugin, MCP, Skill)

### Claude Code 设计

**Plugin系统:**
- `.claude-plugin/plugin.json` 清单: commands, agents, hooks, skills, MCP servers, output styles
- 发现路径: bundled → project `.claude/` → user dir → marketplace
- 验证 + 错误隔离加载
- **~44个plugin相关文件**

**MCP:**
- 完整的 MCP client: stdio, SSE, HTTP 传输
- OAuth 支持 (`auth.ts`)
- React context for reconnect/toggle
- 集成到工具池 via `assembleToolPool`

**Skills:**
- 多来源: project/user/policy `.claude/skills/`, bundled, MCP-provided
- Frontmatter 解析 (`parseSkillFrontmatterFields`)
- `SkillTool` 在工具列表中
- 内置skills (`/update-config`, `/keybindings` 等)

### Pi 当前设计

**Extensions:**
- TS模块注册 commands, tools, `pi.on(event, handler)` 处理器
- `ExtensionRunner` 事件分发
- `tool-definition-wrapper.ts` 桥接 `AgentTool` ↔ `ToolDefinition`

**Skills:**
- 文件系统发现 + frontmatter; 注入系统提示

**MCP:**
- 核心包中**无 MCP client/server 实现**
- 仅测试级别提到 `pi-mcp-adapter`

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **MCP Client 集成** | 高 | 极高 | 支持 stdio/SSE/HTTP 的 MCP 客户端，集成到工具池 |
| **Plugin 清单格式** | 中 | 高 | 结构化的 plugin.json 定义 commands/tools/hooks/skills |
| **Plugin 市场/发现** | 中 | 中 | 多级发现路径 (bundled → project → user → marketplace) |
| **Plugin 错误隔离** | 低 | 中 | 单个 plugin 失败不影响其他 |
| **SkillTool** | 低 | 中 | 让 LLM 能主动调用 skill 的工具 |
| **MCP OAuth** | 高 | 中 | MCP 服务器的 OAuth 认证支持 |

---

## 5. Hook系统

### Claude Code 设计

- **~20个事件**: `SessionStart/End`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied/Request`, `SubagentStart/Stop`, `UserPromptSubmit`, `ConfigChange`, `CwdChanged`, `FileChanged`, `Stop` 等
- **4种 Hook 传输**: command (shell), HTTP, agent, function (SDK)
- **退出码契约**: 2 = 阻断错误 — 任何语言都能参与
- **JSON 验证 (Zod)**: 结构化控制; 否则纯文本
- **`PreToolUse` 能力**: allow/deny/ask, 重写input, 停止会话
- **聚合规则**: 最严格者胜 (deny > allow), `updatedInput` 最后胜, `additionalContext` 连接
- **工作区信任门控**: 阻止克隆仓库中的 `.claude/settings.json` 立即执行 hooks
- **异步 hooks + `asyncRewake`**: 长时间检查可**重新进入**对话

### Pi 当前设计

- **两层**: agent-core 的 `beforeToolCall`/`afterToolCall` + coding-agent 的 `ExtensionRunner` 事件
- `EventBus` 通用事件总线
- 扩展事件: `tool_call`, `tool_result`, `input`, `before_agent_start`, `context`, `session_before_*` 等
- `emitToolCall` 第一个返回 `block` 的处理器胜出

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **多传输 Hook** | 中 | 高 | 支持 shell command / HTTP / function 多种 hook 类型 |
| **退出码契约** | 低 | 中 | 标准化的 hook 返回值协议 |
| **Hook 聚合规则** | 低 | 高 | 文档化的多 hook 聚合语义 (deny>allow) |
| **工作区信任检查** | 中 | 高 | hook 执行前的信任验证 |
| **PreToolUse 输入重写** | 低 | 中 | hook 能修改工具输入参数 |
| **异步 Hook + 重入** | 高 | 中 | 长时间 hook 完成后能重新进入对话 |

---

## 6. Bash引擎

### Claude Code 设计

- **Bash AST 解析器** (`bash/` ~7,000+ 行): AST parsing, heredoc, quoting, pipe 处理 (注: 架构文档未明确提及 tree-sitter, 具体实现需源码验证)
- 命令分类: read-only验证, 路径检查, `bashSecurity` 分类
- **SandboxManager** (`sandbox-adapter.ts` → `@anthropic-ai/sandbox-runtime`):
  - macOS: `sandbox-exec` (seatbelt), 支持 glob
  - Linux/WSL2: bubblewrap + seccomp (无 glob 支持)
  - **无条件 deny** 写入 settings 路径和 `.claude/skills`
- `Shell.exec` + `ShellCommand` 封装 spawn, timeout, abort, 后台任务
- 命令UI分类 (search/read/silent collapsible groups)
- `_simulatedSedEdit` 隐藏参数 (不在模型schema中, 用户批准 sed 预览后才设置)
- **裸 git 仓库加固** + **执行后清理** 植入的 HEAD/objects
- **Extglob 禁用** (bash/zsh)
- **CWD** 通过 `pwd -P` + **NFC 标准化** (APFS)
- **Size watchdog**: 5s 间隔检测后台任务输出超 `maxOutputBytes`
- **只支持 bash/zsh** (`findSuitableShell`), stdout/stderr 合并到同一 fd

### Pi 当前设计

- `createLocalBashOperations`: `spawn(shell, [...args, command])`, `detached: true`, 流式stdout/stderr
- 可选 timeout + `killProcessTree`
- 可插拔 `BashOperations.exec` 用于远程/SSH
- 滚动缓冲区 + 超大输出写临时文件
- **非零退出码 = 错误** (issue #9: grep/diff/test 等有语义退出码)
- **无默认 timeout** (issue #10)
- 无 AST 分析, 无沙箱

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **命令语义退出码** | 低 | 高 | 为 grep/diff/test 等命令映射退出码语义 (issue #9, 已有 draft) |
| **默认 Bash Timeout** | 低 | 高 | 可配置默认超时 (issue #10, 已有 draft) |
| **命令 AST 分析** | 高 | 中 | Bash 解析器进行安全分类 (Claude Code 有 ~7K 行解析代码) |
| **OS 级沙箱** | 极高 | 高 | macOS seatbelt / Linux bubblewrap 隔离 |
| **命令分类 (UI)** | 低 | 低 | 搜索/读取/静默命令在UI中可折叠 |

---

## 7. 权限系统 (Permission System)

### Claude Code 设计

**7步有序管线:**
1. Deny rules
2. Ask rules
3. `tool.checkPermissions()`
4. Tool deny
5. `requiresUserInteraction`
6. Content ask rules
7. Safety paths (`.git`, `.claude` 等)

**关键特性:**
- **Bypass-immune 步骤** (1d-1g): 即使 `bypassPermissions` 也不能跳过工具拒绝、交互需求、内容ask和安全路径
- **6种模式**: default, plan, acceptEdits, bypass, dontAsk, auto (YOLO分类器)
- **YOLO 分类器**: 只看工具调用记录, **排除assistant文本** — 防止模型通过说服性文字社工绕过
- **2阶段XML分类器**: 快速阻断先行; 需要时才启动"thinking"阶段
- **拒绝熔断器**: 3次连续/20次总计阻断 → 回退到提示(交互)或中止(无头)
- **Iron gate**: 分类器API失败 → fail-closed vs fail-open 运维开关
- **沙箱集成**: 沙箱满足时自动允许bash

### Pi 当前设计

- 权限通过 **extension `tool_call` handler** 返回 `{ block: true, reason }`
- 交互 vs 无头: 示例中 `!ctx.hasUI` 时阻断
- **没有集中式规则引擎**
- 没有 deny/ask/always-allow 矩阵
- 没有安全路径保护
- 没有 YOLO/auto 模式

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **有序权限管线** | 高 | 极高 | 结构化的多步权限检查管线 |
| **Bypass-immune 安全步骤** | 中 | 高 | 某些安全检查不可绕过 |
| **安全路径保护** | 低 | 高 | `.git`, 配置目录等始终需要确认 |
| **拒绝熔断器** | 低 | 中 | 防止 deny/retry 循环 |
| **权限模式 (plan/acceptEdits)** | 中 | 高 | 预定义的权限策略集合 |
| **自动允许规则** | 中 | 中 | 基于历史的自动允许白名单 |

---

## 8. Agent集群 (Agent Swarms)

### Claude Code 设计

- **文件系统邮箱** + **lockfile**: `~/.claude/teams/{team}/inboxes/{name}.json`
- **Backend 抽象**: tmux > iTerm2 > in-process
- **Leader/Worker 层级**: Leader 生成 teammates, workers 委托权限给 leader
- **邮箱消息类型**: DMs, broadcast, `idle_notification`, `permission_request/response`, shutdown
- **Team manifest** (`config.json`): 稳定ID (`name@team`)
- **清理**: kill 孤儿进程, 删除 team 目录, 销毁 worktrees

### Pi 当前设计

- **没有** Agent集群/Swarm 功能
- `packages/pods` 是 GPU pod/vLLM 管理, 不是 agent 协调

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **Agent Team API** | 极高 | 高 | Leader/worker 层级 + 邮箱通信 |
| **简单文件 IPC** | 高 | 中 | 文件系统邮箱, 比复杂IPC更可靠可调试 |
| **权限委托协议** | 高 | 高 | Worker 通过消息向 Leader 请求权限 |
| **多 Backend 支持** | 中 | 中 | tmux / terminal / in-process 后端 |

---

## 9. 会话管理 (Session Management)

### Claude Code 设计

- **Append-only JSONL**: `~/.claude/projects/{sanitized-cwd}/{session-id}.jsonl`
- **parentUuid 链**: 线性历史, 分支, forks, compaction 边界
- **Project 单例**: 延迟文件创建 (首条消息时才创建)
- **双写模式**: 异步队列 (100ms合并) + 同步路径 (退出时)
- **UUID 去重** (agent sidechains 除外)
- **Resume 管线**: parse JSONL → Map → relink → snip → pick leaf → chain → orphan recovery → deserialize → 中断检测
- **轻量列表**: stat + 64KB head/tail, metadata 重新追加到文件尾部
- **远程同步**: Session Ingress + CCR 内部事件

### Pi 当前设计

- JSONL 会话文件, `SessionEntry` 变体 (message, thinking_level_change, model_change, compaction, branch_summary, custom 等)
- `buildSessionContext`: leaf→root 树遍历, compaction 摘要注入
- `CURRENT_SESSION_VERSION = 3` + 迁移
- 延迟持久化直到首条 assistant 消息
- 版本迁移 (v1→v2→v3)

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **写合并队列** | 中 | 中 | 100ms 窗口合并写入, 减少 I/O |
| **轻量会话列表** | 低 | 中 | 64KB head/tail + metadata 尾部重追加 |
| **中断检测/恢复** | 中 | 高 | Resume 时检测中断点, 注入 synthetic "Continue" |
| **一致性检查** | 低 | 中 | chain length vs turn_duration 检查 |
| **UUID 去重** | 低 | 低 | 防止重复条目 (sidechain 除外) |

---

## 10. 上下文组装 (Context Assembly)

### Claude Code 设计

**三层分离:**
1. **系统提示**: 静态前缀 + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` + 会话特定尾部
2. **用户/系统上下文**: memoized (`getUserContext`, `getSystemContext`, git)
3. **每轮附件**: `getAttachments()` (~1s timeout)

**Memory 层级** (低→高优先级):
managed `/etc` → user `~/.claude` → CWD→root walk → `CLAUDE.local.md` → AutoMem `MEMORY.md` → team memory

**优化:**
- **Section registry + 缓存**: memory/settings/worktree 变更时清除
- **延迟工具**: 发现后才发送; `deferred_tools_delta` / `mcp_instructions_delta` 用于中间变更
- **稳定头部**: 预计算以避免 prompt cache 失效
- **Todo/plan 提醒**: 每 N 轮注入

**条件规则**: frontmatter `paths:` + picomatch → 工具触碰匹配路径时注入嵌套附件

### Pi 当前设计

- `buildSessionContext()`: 树遍历 + compaction 摘要
- `convertToLlm()`: 自定义角色 → user/assistant/toolResult
- `buildSystemPrompt()` / `_rebuildSystemPrompt`: 资源加载 + 工具片段
- `transformContext` 作为扩展点

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **Static/Dynamic 系统提示分割** | 中 | 高 | 显式分割点保护服务端 prompt cache |
| **上下文 memoization** | 低 | 中 | 稳定上下文只计算一次 (git, 用户配置等) |
| **附件超时** | 低 | 中 | per-turn 附件构建硬超时 (1s) |
| **条件规则注入** | 中 | 中 | 基于文件路径 glob 的条件性上下文注入 |
| **延迟工具 delta** | 高 | 中 | 中间会话工具变更只发送 delta |
| **周期性 plan/todo 提醒** | 低 | 低 | 每 N 轮注入计划/待办提醒 |

---

## 11. Compaction (上下文压缩)

### Claude Code 设计

**三级压缩:**
1. **MicroCompact**: per-turn, 工具结果聚焦; 两条路径:
   - Cold cache → 清除旧内容, 替换占位符
   - Warm cache → API 层 `cache_edits` **不修改本地数据** (保护 prompt cache)
2. **Session Memory Compact**: 无 LLM 调用, 使用预构建的会话记忆摘要替换旧线程
3. **Full Compact**: PreCompact hooks → 剥离图片/附件 → fork 总结 → 剥离 `<analysis>` 草稿 → 清除文件状态 → 重注入近期文件/skills/plan/deltas → SessionStart/PostCompact hooks

**关键特性:**
- **API-round 分组** 用于安全截断 (不切割 tool_use/tool_result)
- **`adjustIndexToPreserveAPIInvariants()`**: 不能孤立 thinking 或拆分 tool_use/result
- **Compact 方向**: `'from'` vs `'up_to'`, 不同的缓存保留语义
- **熔断器**: `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` → 停止本会话自动compact
- **递归守卫**: `querySource` 为 `session_memory` / `compact` / `marble_origami` 时不触发
- **Compact后补水预算** (精确值):
  - `POST_COMPACT_MAX_FILES_TO_RESTORE = 5`
  - `POST_COMPACT_TOKEN_BUDGET = 50,000`
  - `POST_COMPACT_MAX_TOKENS_PER_FILE = 5,000`
  - `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5,000`
  - `POST_COMPACT_SKILLS_TOKEN_BUDGET = 25,000`
  - 还恢复: active plan, plan mode instructions, deferred tool deltas, MCP instruction deltas, SessionStart hooks, 16KB title tail
- **Session Memory 阈值**: `minTokens: 10,000`, `minTextBlockMessages: 5`, `maxTokens: 40,000`
- **Auto-compact**: `AUTOCOMPACT_BUFFER_TOKENS = 13,000`; 有效窗口扣除 `min(maxOutput, 20,000)`
- **告警阶梯**: 有效窗口 −20K (warning/error), −13K (auto-compact), −3K (blocking limit)
- **PTL 重试**: 最多 3 次, 删除最旧 API-round 组; 无法解析时 fallback 20% 组
- **MicroCompact token 估算**: 填充 4/3 倍; images/PDFs 固定 2,000 tokens
- **`COMPACTABLE_TOOLS` 集合**: Read, Shell, Grep, Glob, Web*, FileEdit/Write — **AgentTool / MCP 结果保留**

### Pi 当前设计

- 单一 LLM 总结路径: `generateSummary` / `generateTurnPrefixSummary`
- `findCutPoint`: 保留 `keepRecentTokens`, 避免孤立 tool results
- `prepareCompaction`: 基于 session context 的 token 估算
- `extractFileOperations` + `formatFileOperations`
- Token 估算: chars/4 启发式

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **MicroCompact (Tier 1)** | 中 | 极高 | per-turn 清理旧工具结果, 与 prompt cache 对齐 |
| **Session Memory Compact (Tier 2)** | 中 | 高 | 无 LLM 调用的快速压缩层 |
| **Compact后补水** | 低 | 高 | 压缩后重注入关键上下文 (文件状态, skills, plan) |
| **API-round 安全截断** | 中 | 高 | 保证不切割 tool_use/result 对 |
| **Compact 熔断器** | 低 | 中 | 防止无限 compact 重试 |
| **递归守卫** | 低 | 中 | 压缩过程中不触发自动压缩 |
| **`<analysis>` 草稿剥离** | 低 | 中 | 从摘要中移除推理草稿, 只保留结论 |

---

## 12. Prompt Cache (提示缓存)

### Claude Code 设计

- **`getCacheControl`**: `type: 'ephemeral'`, 可选 `ttl: '1h'`, 可选 `scope: 'global'`
- **3层缓存**: 默认 ephemeral (~5m), 1h TTL (符合条件的用户), global scope (稳定系统提示)
- **稳定性规则** (关键):
  - Beta headers 是缓存键的一部分 → 会话稳定的 **latches**: 一旦开启不再关闭
  - 1h资格 + GrowthBook白名单在首次评估时锁定
  - 消息序列化字节稳定
  - 工具排序稳定
- **成本**: 文档引用 cache miss vs hit **~12x** 成本差异
- **`promptCacheBreakDetection.ts`**: 缓存命中分析

### Pi 当前设计

- Provider级别的缓存: `cacheRetention`, `sessionId` on `StreamOptions`
- Token计费包含缓存token (`cacheRead` / `cacheWrite`)
- 缓存语义**因provider而异**
- 没有统一的缓存管理层
- 没有缓存键稳定性保证

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **系统提示 Static/Dynamic 分割** | 中 | 极高 | 稳定前缀标记 global cache, 动态后缀标记 ephemeral |
| **Latch 机制** | 低 | 高 | 会话内不翻转影响缓存键的标志 |
| **消息字节稳定性** | 中 | 高 | 序列化格式稳定, 避免不必要的缓存失效 |
| **缓存失效检测** | 中 | 中 | 检测并报告 prompt cache 失效原因 |
| **MicroCompact cache_edits** | 高 | 高 | API层编辑而非本地修改, 保护缓存 |

---

## 13. 状态管理 (State Management)

### Claude Code 设计

- **~35行 `createStore`**: `getState` / `setState` / `subscribe` + `useSyncExternalStore`
- **`AppState`**: 大型不可变类型对象 (model, permissions, UI, MCP 等)
- **`onChangeAppState`**: 集中式状态变更副作用处理
- **forked Ink**: React 19 ConcurrentRoot, 自定义 reconciler, Yoga 布局, 16ms 帧节流
- **Virtual list**: viewport + buffer, WeakMap 高度缓存, scroll clamp, sticky bottom
- **分离**: 终端 UI 状态 vs QueryEngine 会话状态

### Pi 当前设计

- `AgentState` (agent): messages, tools, model, streaming flags
- `SettingsManager` (coding-agent): 用户/项目设置
- Interactive mode (TUI): 大量界面状态
- 状态**分散**在 Agent, SessionManager, SettingsManager, 和模式特定UI中
- 无单一 store

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **最小化 Store** | 中 | 中 | `createStore` + `useSyncExternalStore` 模式 |
| **集中 onChange 处理** | 低 | 中 | 单一副作用中心 (持久化, 通知, 缓存清除) |
| **UI/会话状态分离** | 中 | 中 | 清晰分离 TUI 状态 vs agent 状态 |

---

## 14. Memory (跨会话记忆)

### Claude Code 设计

- **CLAUDE.md 层级**: managed `/etc` → user `~/.claude` → CWD→root walk → `CLAUDE.local.md`
- **`@include` 语法**: 支持相对/绝对/`~` 路径引用
- **AutoMem `MEMORY.md`**: `~/.claude/memory/MEMORY.md`, 行/字节上限
- **DreamTask 后台整合** (特性门控): 后台定期整合记忆
- **条件规则 (`.claude/rules/*.md`)**: frontmatter `paths:` + picomatch, 工具触碰匹配路径时注入
- **Team 记忆同步**
- **记忆缓存**: 加载一次; compact/worktree/设置变更时失效
- **`contentDiffersFromDisk`**: 跟踪注入内容与磁盘内容差异

### Pi 当前设计

- Session memory: JSONL sessions + compaction summaries
- 上下文文件 + skills 注入系统提示
- `mom` 有 MEMORY.md 但是 Slack 专用
- **无向量数据库**, 无自动跨会话记忆
- 无 `@include` 语法
- 无条件规则注入

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **Memory 文件层级** | 中 | 高 | 多级 memory 文件 (managed → user → project) |
| **AutoMem** | 高 | 高 | 自动从会话提取记忆到持久文件 |
| **条件规则 (path-based)** | 中 | 高 | 文件路径匹配时自动注入相关规则 |
| **`@include` 语法** | 低 | 中 | Memory文件中引用其他文件 |
| **记忆缓存 + 失效** | 低 | 中 | 一次加载, 事件触发失效 |
| **Team 记忆同步** | 高 | 中 | 多agent共享记忆 |

---

## 15. 启动与Bootstrap

### Claude Code 设计

**快速路径架构:**
- `cli.tsx` — **每条路径最小工作量**: `--version` 打印 `MACRO.VERSION`, **零 import**
- 每个 CLI 分支使用 `await import()` 动态加载只需要的子图
- **Early input buffer**: `startCapturingEarlyInput()` 在 `main.tsx` import 前启动, 缓冲 ~500ms 内的按键

**`main.tsx` (200+ 静态 import):**
- `profileCheckpoint` 用于启动性能监控
- `eagerLoadSettings` 必须提前运行 (部分模块在 import 时捕获环境常量)

**`init()` (memoized, 单次执行) 有序步骤:**
1. configs
2. safe env (在信任对话框之前)
3. extra CA certs (在 TLS 之前)
4. graceful shutdown handlers
5. **lazy** OTEL telemetry init (~400KB+ deferred)
6. OAuth account
7. JetBrains 检测
8. git repo
9. mTLS
10. global agents
11. `preconnectAnthropicApi()` (fire-and-forget HEAD, 10s timeout; 跳过 proxy/mTLS/socket/Bedrock/Vertex)
12. Windows shell
13. scratchpad

**`setup()` (post-trust):**
- UDS messaging, teammate snapshot, terminal backup, `setCwd` + hooks
- `--bare` (SIMPLE mode) 跳过: UDS, teammate, terminal backup, plugin prefetch, attribution hooks

**`bootstrap/state.ts` (~1,759 行):**
- **DAG leaf** — ESLint 规则禁止从 `src/` import, 破除循环依赖
- 80+ 字段: identity, cost, per-turn metrics, lazy telemetry refs
- **Sticky latches**: `afkModeHeaderLatched`, `fastModeHeaderLatched`, `cacheEditingHeaderLatched` — 防止 prompt cache 失效

**启动性能监控:**
- 采样率: 内部 100%, 外部 0.5%
- 阶段: `import_time` / `init_time` / `settings_time` / `total_time`
- `CLAUDE_CODE_PROFILE_STARTUP=1` 详细输出到 `~/.claude/startup-perf/`

**消融实验**: `ABLATION_BASELINE` + 环境变量可禁用 thinking, compact, auto-memory, background tasks

### Pi 当前设计

- 入口: coding-agent 的 CLI 解析 → AgentSession 初始化
- 无动态 import 快速路径优化
- 无 early input buffer
- 无启动性能 profiling
- 无 preconnect/prefetch
- 无 DAG leaf 状态模块

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **动态 import 快速路径** | 低 | 中 | `--version` 等零import; CLI分支按需加载 |
| **Early input buffer** | 低 | 中 | import 前缓冲用户输入, 改善感知启动速度 |
| **API preconnect** | 低 | 低 | fire-and-forget TCP+TLS 预热 |
| **Leaf 状态模块** | 中 | 中 | 全局状态作为 DAG leaf, ESLint 强制无反向依赖 |
| **启动 profiling** | 低 | 低 | 可选的启动性能检查点 |
| **Bare/CI 模式** | 低 | 中 | 跳过 UDS, plugins, attribution 等非必要初始化 |

---

## 16. Bridge系统 (远程控制)

### Claude Code 设计

**用途:** Web (claude.ai) 驱动**本地执行**; 用户在浏览器操作, 本地 agent 执行命令

**两种模式:**
1. **Standalone** (`claude remote-control`): 注册环境, 轮询任务, 生成子进程 `claude --print --sdk-url ...`, NDJSON stdout → bridge → server
2. **REPL** (`/remote-control`): `replBridge.ts`, in-process, 双向, 历史刷新到 web

**传输演进:**
- **v1**: WebSocket 读 + HTTP POST 写, OAuth
- **v2**: SSE 读 + `CCRClient` POST (`SerialBatchEventUploader`), JWT, heartbeat ~20s, **worker epoch** — 过期 epoch 返回 409 强制重连
- **v3** (`remoteBridgeCore`): OAuth → `worker_jwt`, 无完整 Environments API 轮询

**关键机制:**
- **Epoch 单调性**: 拒绝过期 worker, 强制完全重连
- **Split backoff**: 网络错误 vs 应用错误分开回退 (2s→120s cap vs 500ms→30s cap, 10min 放弃)
- **Capacity wake** (`AbortController`): 达到 32 并发时,slot 释放时立即唤醒
- **stdin 密钥刷新**: 通过 `update_environment_variables` 消息刷新子进程环境变量
- **FlushGate**: 历史刷新期间排队消息, 完成后 drain, 保证顺序
- **Crash recovery**: `writeBridgePointer` (sessionId, environmentId, source), 重启时复用环境 ID, `MAX_ENVIRONMENT_RECREATIONS = 3`
- **权限代理**: 子进程 `control_request` → bridge → server → claude.ai UI → `control_response`

### Pi 当前设计

- `packages/web-ui`: 浏览器UI, 但不是远程控制架构
- 无 bridge/remote control 系统
- 无 NDJSON 子进程协议

### 可借鉴的改进 (长期方向)

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **NDJSON 子进程协议** | 中 | 高 | 标准化的 headless agent worker 集成接口 |
| **远程控制架构** | 极高 | 高 | Web/IDE 驱动本地执行 (如果 Pi 需要 IDE 集成) |
| **Epoch 单调性** | 中 | 中 | 重连 worker 的过期检测机制 |
| **Stdin 密钥刷新** | 低 | 中 | 长期运行子进程的环境变量安全更新 |

---

## 17. 遥测、隐私与运维控制

### Claude Code 设计

**双通道遥测:**
- **Channel A (1P)**: 专用 OTEL LoggerProvider, protobuf 批次到 `api.anthropic.com`, 10s 刷新 / 200 批次 / 8k 队列, **磁盘持久化**重试, GrowthBook 可调配置
- **Channel B (Datadog)**: 白名单 ~64 `tengu_*` 事件类型, 15s 刷新, **基数控制**: MCP tools → `"mcp"`, model 标准化, `SHA256(userId) % 30` 分桶

**隐私:**
- Repo URL 哈希为 16 hex 字符 (伪匿名)
- Bash 只记录文件**扩展名** (17种命令), 不记录路径
- 工具输入截断 (512/4096/20/depth)
- `OTEL_LOG_TOOL_DETAILS=1` 用于调试时完整捕获

**远程管理设置:**
- `GET .../api/claude_code/settings`, 10s 超时, 5 次重试, **每小时轮询**, ETag, **stale-while-revalidate**, fail-open
- **Accept-or-die**: 危险变更弹确认框 — 拒绝 → `gracefulShutdownSync(1)` (非交互模式静默应用)

**6个紧急开关:**
1. Permissions bypass killswitch
2. Auto mode denials
3. Fast mode (Penguin) + API
4. Analytics sink
5. Agent teams
6. Voice emergency off

**三级特性门控:**
1. Bun `feature()` 编译时 DCE
2. `USER_TYPE === 'ant'` 运行时
3. GrowthBook 远程开关

**Undercover 模式 (内部):** 隐藏 AI 在 commits/PRs 中的痕迹, fail-safe conceal, prompts 禁止 codenames

### Pi 当前设计

- OSS 项目, 强调用户可见性和社区透明度
- 无遥测系统
- 无远程配置/killswitch
- 无特性门控系统
- 公开的 CHANGELOG 和特性名

### 可借鉴的改进

| 改进项 | 难度 | 影响 | 描述 |
|--------|------|------|------|
| **可选 opt-in 遥测** | 中 | 中 | OSS 友好的 opt-in 使用统计 |
| **远程配置 (fail-open)** | 高 | 中 | 可选的远程设置推送, fail-open 保证可用性 |
| **特性门控** | 低 | 中 | 编译时/运行时特性开关, 用于实验性功能 |
| **基数安全的指标** | 低 | 低 | 如果添加分析, 使用分桶/归一化控制基数 |

> **注意**: Pi 作为 OSS 项目, 遥测和远程控制的设计哲学与 Claude Code (商业产品) 有根本不同。
> Claude Code 的**工程模式** (磁盘持久化重试, hot-swap telemetry, split backoff) 值得借鉴,
> 但其**隐私模型** (有限的用户 opt-out, 远程 killswitch) 不适合直接移植到 OSS 项目。

---

## 18. PR建议优先级 — 通过 Pi 的设计哲学重新评估

### Pi 的核心原则 (必须理解)

> "pi's core is minimal. If your feature doesn't belong in the core, it should be an extension."
> — CONTRIBUTING.md

Pi 故意选择了 **minimal core + extensibility** 路线。Claude Code 的很多设计是为**商业产品**服务 (垂直集成、远程控制、遥测、killswitch)，直接移植到 Pi 既不现实也不符合 Pi 的设计目标。

**三个判断标准:**
1. **真正的 bug**: 代码行为违反了其自身的预期语义 → **提 issue**
2. **安全/可靠性缺陷**: 可能导致数据丢失或系统挂起 → **提 issue**
3. **设计增强**: Claude Code 做得更好，但 Pi 的做法不算"错" → **大部分不提，或作为 discussion**

---

### 已有 Issue Drafts (直接可提交)

| 优先级 | Issue | 文件 | 类型 | 原因 |
|--------|-------|------|------|------|
| P0 | bash 语义退出码 | `pi_issue_9_draft.md` | **Bug** | 客观语义错误, grep exit 1 ≠ error |
| P1 | read 二进制检测 | `pi_issue_6_draft.md` | **Bug/遗漏** | 团队已修复 bash 同类问题, read 是遗漏 |
| P1 | bash 默认超时 | `pi_issue_10_draft.md` | **可靠性** | maintainer 可能认为应由模型传参, 有设计分歧 |
| P2 | stopReason=length | `pi_issue_1_draft.md` | **边界** | 需先验证实际触发频率 |
| P2 | edit 外部修改检测 | `pi_issue_11_draft.md` | **增强** | 有部分保护 (oldText匹配), 跨工具状态增加耦合 |

---

### 新发现的改进建议 — 重新评估

#### 真正适合 Pi 核心的 (Bug/可靠性级别)

| # | 标题 | 评估 | Pi 会接受吗？ |
|---|------|------|-------------|
| N5 | Compact 安全截断 | 如果当前 compaction 真的会切割 tool_use/result 对, 这是 **正确性 bug** | **可能接受** — 需要先验证 `findCutPoint` 是否真的有此问题 |
| N6 | 流空闲看门狗 | SSE 流挂起导致 session 卡死, 与 bash timeout (issue #10) 同级 | **可能接受** — 小改动, 但可能被认为是 provider 层的责任 |

#### 有价值但需要以 extension 方式提出的

| # | 标题 | 为什么不适合核心 | 建议方式 |
|---|------|-----------------|----------|
| N1 | 工具并发安全标志 | Pi 当前仍是全局 sequential/parallel；若引入 `isConcurrencySafe` 或类似接口，会改变 AgentTool 接口并增加调度复杂度 | 作为 **extension API 增强** 讨论, 不作为 bug |
| N2 | MicroCompact | 增加压缩层级, 增加核心复杂度; Pi 单级压缩是有意简化 | 作为 **feature discussion** 提出 |
| N3 | Compact后补水 | 需要跟踪更多状态 (哪些文件/skills需要恢复), 增加复杂度 | 作为 compaction 改进 **discussion** |
| N7 | 安全路径保护 | Pi 的权限模型是 "DIY via extensions", 集中式安全路径违反设计 | 作为 **example extension** 提供 |
| N10 | 条件规则注入 | 需要 picomatch 依赖 + frontmatter 解析 + 路径匹配钩子 | 可能适合 extension |

#### Claude Code 特有设计, Pi 故意不做的 (不建议提)

| # | 标题 | 为什么 Pi 不需要 |
|---|------|-----------------|
| N4 | Static/Dynamic 系统提示分割 | Anthropic API 特有的 prompt cache 机制; Pi 支持多 provider, 不应绑定 Anthropic 优化 |
| N8 | 有序权限管线 | 完全违反 Pi "权限 = extension" 的哲学; 7步管线是 Claude Code 商业产品需求 |
| N9 | Hook 多传输支持 | Pi 已有 extension event 系统; shell/HTTP hook 是 Claude Code 企业需求 |
| N11 | Memory 文件层级 | managed/user/project/local 四级是 Anthropic 企业+个人产品需求 |
| N12 | Plugin 清单格式 | Pi 已有 extension 系统, 另建 plugin 体系重复 |
| N13 | 延迟工具加载 | Pi 内置工具少 (~7), 不需要延迟加载; 只在 MCP 集成大量外部工具时才有意义 |
| N14 | MCP Client 集成 | 除非社区强烈需求, 否则是大工程且增加大量依赖 |
| N15-N19 | SubAgent/Team/Sandbox/Coordinator | 全部是产品级功能, 不属于 minimal core |

---

### 诚实评估: 你实际能提什么 PR

**现实:** 作为新贡献者, 大部分 Claude Code 的架构模式**不适合**作为 Pi 的 issue 或 PR。Pi 的 maintainer 会对任何增加核心复杂度的建议持谨慎态度。

**可行的行动:**

1. **先提 Issue 9 (bash 退出码)** — 这是最安全的首次贡献, 客观 bug, ~20 行修复
2. **被接受后提 Issue 6 (read 二进制)** — 团队已修复 bash 的同类问题
3. **Issue 10 (bash timeout)** — 视社区反应决定
4. **N5/N6 (compact 安全截断/流看门狗)** — 需要先验证问题是否真实存在, 然后以 bug report 而非 feature request 方式提

**不要做的:**
- 不要一次提多个 issue (显得在"审计"项目)
- 不要在 issue 中提到 Claude Code
- 不要提 "增加权限管线/MicroCompact/Plugin系统" — 这些违反 Pi 的设计哲学
- 不要把 Claude Code 的 "垂直集成商业产品" 逻辑套到 "最小核心 OSS 框架" 上

---

### 值得内部学习但不适合外部提交的

以下 Claude Code 模式对**你自己**基于 Pi 构建的项目有参考价值, 但不适合作为 Pi 上游的 issue:

| 模式 | 学习价值 | 可在何处应用 |
|------|----------|-------------|
| Pre-API 5阶段压缩管线 | 理解上下文管理的层级策略 | 你自己的 Pi extension |
| Prompt cache 稳定性 (latch/immutable messages) | 理解 API 经济学 | 你的 provider 配置 |
| 13步工具执行管线 | 理解防御式工具执行 | 你的 extension 中的 tool_call handler |
| YOLO 分类器设计 (排除 assistant 文本) | 理解安全模型绕过风险 | 你的 permission extension |
| 文件系统邮箱 (agent swarm) | 简单可靠的多进程 IPC | 你的 multi-agent extension |
| AsyncGenerator 统一消息管道 | 优雅的流式架构 | 可在 extension 中使用类似模式 |
| Bootstrap/startup 优化 | 理解启动性能 | 对 Pi 启动慢的诊断/优化 |

---

## 附录: 架构哲学对比

| 维度 | Claude Code | Pi | 差异是否是"问题"? |
|------|------------|-----|-----------------|
| **整体理念** | 垂直集成, 自上而下控制 | 最小核心 + 横向扩展 | 不是 — 不同的产品定位 |
| **工具执行** | 流式执行 (边流边跑) | 全消息完成后执行 | 不是 — Pi 优先简单性 |
| **权限模型** | 集中式管线, 多规则源 | DIY via extensions | 不是 — Pi 有意让用户自定义 |
| **状态管理** | 最小 store + React 19 | 分散在多个 manager 中 | 部分 — 可以改善但不紧急 |
| **MCP** | 深度集成到工具池 | 外部适配器 | 取决于社区需求 |
| **Memory** | 文件层级 + 自动提取 | 会话级 + 手动 | 取决于使用场景 |
| **Compaction** | 3级 (micro/session/full) | 单级 LLM 总结 | 部分 — compact质量可改善 |
| **Prompt Cache** | 精心维护, latch 机制 | 透传 provider | 不是 — Pi 是多 provider |
| **Multi-Agent** | 内置 coordinator + swarm | 外部进程 only | 不是 — Pi 优先简单性 |
| **沙箱** | OS 级 (seatbelt/bubblewrap) | 无 | 取决于安全需求 |

> **核心洞察:** Pi 和 Claude Code 解决的是**不同的问题**。
> - Claude Code 是 Anthropic 的**商业产品** — 需要遥测、远程控制、企业级权限、prompt cache 优化以控制运营成本
> - Pi 是**开源框架** — 需要简单、可理解、可扩展的核心
>
> 把 Claude Code 的复杂度移植到 Pi 上, 就像把 Kubernetes 的 admission controller 移植到 Docker Compose — 技术上可以, 但违背了项目的存在理由。
>
> **真正有价值的是:** 理解 Claude Code 的设计**为什么**这样做, 然后在你**自己的** Pi extension 中应用这些思路。
