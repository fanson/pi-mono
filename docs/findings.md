# Findings

## Current Baseline
- 当前工作树中已修改的目标仍然全部在 `docs/**` 下。
- 已经完成一轮修复的 study 文档包括：`00/01/02/03/04/05/06/07/10`。
- 已经完成一轮修复的 issue 文档包括：`pi_issues_reproduction.md`、`comparison_report.md`。

## Known Remaining Risk Areas
- `docs/issue/pi_issue_1_draft.md`
- `docs/issue/pi_issue_6_draft.md`
- `docs/issue/pi_issue_9_draft.md`
- `docs/issue/pi_issue_10_draft.md`
- `docs/issue/pi_issue_11_draft.md`
- `docs/issue/pi_issues_final_evaluation.md`
- `docs/study/09-design-patterns-and-contribution-guide.md`
- `docs/study/10-testing-and-contribution.md`
- `docs/study/12-compaction-comparison.md`
- `docs/study/13-extended-feature-comparison.md`
- `docs/study/README.md`
- `docs/study/_sidebar.md`

## Already Confirmed Modernized Facts
- CLI JSON/RPC 入口应写作 `--mode json` / `--mode rpc`
- `createAgentSession()` 返回 `{ session, ... }`，不能直接当成 session 实例
- extension `session_directory` 事件已不存在
- provider 解析入口是 `resolveApiProvider(...)`
- 工具执行的默认路径仍由全局 `toolExecution` 控制，但 `AgentTool.executionMode` 已存在；当前 runtime 会把命中 `executionMode: "sequential"` 的整批调用拉回串行

## Working Principle
- 只把“有源码证据支持的失真”记为待修点
- 不把 issue 文档的假设性修复建议，当成当前代码事实
- `study/architecture-analysis` 不是一次性修文档分支，而是长期维护的“最新代码 + 持续更新 docs 层”分支
- 未来的标准操作应该是：先把代码基线对齐到最新 `origin/main`，再只在 `docs/**` 上持续演进学习/面试材料
- 需要临时同步分支或隔离 worktree 时，它们只是安全工具，不是长期承载分支
- 该长期模型现已被写入 `fork/study/architecture-analysis` 的 `docs/CLAUDE.md`，成为 docs overlay 内的持久规则

## Latest Upstream Delta (post-`f8712a25`)
- 上游新增 3 个提交：
  - `6b55d685` `fix(tui): restore shifted xterm input`
  - `da6a81d3` `fix(coding-agent): reuse session thinking for compaction`
  - `d66ef6dc` `fix(coding-agent): add missing typebox dependency`
- 其中真正对 study 文档产生 material impact 的只有 compaction 行为变更：
  - `AgentSession.compact()` / 自动 compaction 现在会把 `this.thinkingLevel` 传入 `compact(...)`
  - `generateSummary()` / `generateTurnPrefixSummary()` 不再固定 `reasoning: "high"`
  - 新规则是：只有模型支持 reasoning 且 `thinkingLevel` 已设置并且不为 `off` 时，才传 `reasoning: thinkingLevel`
- 因此需要更新的 study 文档仅有：
  - `docs/study/08-compaction-and-sessions.md`
  - `docs/study/12-compaction-comparison.md`
- `fix(tui): restore shifted xterm input` 属于终端按键/输入实现修复，当前 study 文档没有写到该粒度，因此不构成 material mismatch
- `add missing typebox dependency` 主要是包依赖声明修复；现有 study 文档虽提到 `@sinclair/typebox`，但没有对这次依赖补声明产生事实性偏差

## Latest Upstream Delta (post-`3ee67372`)
- 上游新增 1 个提交：
  - `aa1b587b` `fix(ai): add direct OpenAI completions prompt caching`
- 这次真正影响文档的是 `packages/ai/src/providers/openai-completions.ts`：
  - 对直连官方 `api.openai.com` 的 `openai-completions` 路径，也会设置 `prompt_cache_key`
  - 当 `cacheRetention === "long"` 时，也会设置 `prompt_cache_retention: "24h"`
  - 对第三方代理 / OpenAI-compatible base URL，仍不会注入这两个字段
- 因此需要更新的文档只有：
  - `docs/study/01-pi-ai-layer.md`
- 更新点不是“新增一个全新缓存概念”，而是把 Prompt Cache 的 provider/file 映射从“只写 OpenAI Responses”补成“OpenAI Responses + 直连官方 OpenAI Completions”
- `docs/study/13-extended-feature-comparison.md`、`docs/issue/**` 本轮没有 material mismatch

## New Audit Findings

### `docs/issue/**`
- 本轮重新核对 `packages/agent/src/types.ts` 与 `packages/agent/src/agent-loop.ts` 后确认：
  - `AgentTool` / extension `ToolDefinition` 都已经暴露 `executionMode?: ToolExecutionMode`
  - runtime 当前只把 `executionMode: "sequential"` 当成 coarse 的整批回退开关
  - 仍然没有 Claude Code 那种按工具安全性切成 `[并行块] → [串行块] → [并行块]` 的分区调度
  - 因此 `Issue 4` 需要从“没有 tool-level 字段”改写成“缺少真正的分区批处理”
- `pi_issue_1_draft.md`
  - “Suggested fix” 用 `JSON.stringify(arguments)` 检查截断 tool call 的方案不成立，会误导对真实失败模式的理解
- `pi_issue_6_draft.md`
  - 实质判断仍成立，但 `read.ts` UTF-8 路径的源码行号应校到 186–188
- `pi_issue_9_draft.md`
  - `bash.ts` 和 `agent-loop.ts` 的源码行号已漂移
- `pi_issue_10_draft.md`
  - `bashSchema` 与 timeout block 的源码行号已漂移
- `pi_issue_11_draft.md`
  - `edit.ts` 的实际 execute 路径行号已变化；现在还要带上 `withFileMutationQueue()` 的上下文
- `pi_issues_final_evaluation.md`
  - 与 drafts 一样，核心结论大体仍成立，但引用行号需要刷新
- `pi_issues_reproduction.md`
  - 首轮审计曾发现并修正过一批事实性错误：
    - Issue 1 的 `models.json` 示例说明
    - Issue 2 的 JSON mode 取证命令
    - Issue 9 的 jq 字段示例
    - Issue 6 的代码锚点与不稳定路径引用
- `comparison_report.md`
  - compaction 触发不只发生在 `agent_end` 后，也会在发送新用户消息前检查
  - Pi 并非“没有 compaction hooks”，而是通过 `session_before_compact` / `session_compact` 暴露

### `docs/study/**`
- `00-architecture-overview.md`
  - `getEnvApiKey()` 的 provider 名称应为 `github-copilot`，不是 `copilot`
- `02-agent-core-layer.md`
  - 并行分支的进入条件还要加上“本批没有命中 `executionMode: "sequential"` 的工具”
- `03-coding-agent-layer.md`
  - `createAgentSession()` 不是给 Agent 传一个 `getApiKey` 回调，而是在 `streamFn` 内调用 `modelRegistry.getApiKeyAndHeaders(model)` 再转给 `streamSimple(...)`
  - `_handleAgentEvent()` 的实际顺序是：扩展先看见事件、再通知 listeners，`message_end` 时才持久化
  - `DefaultResourceLoader.reload()` 图示要写成 `loadExtensions()` / `loadExtensionFactories()`，并带上 CLI path precedence
- `04-print-json-rpc-protocol-and-event-contracts.md`
  - RPC `prompt` 的 `success` 不是“命令一到就返回”，而是 preflight 成功后才输出；queued / immediately handled 也算成功
- `README.md`
  - 目录表只列到 10，但 `_sidebar.md` 已包含 11、12
- `09-design-patterns-and-contribution-guide.md`
  - `generate-models.ts` 路径应为 `packages/ai/scripts/generate-models.ts`
  - `register-builtins.ts` 应指向 `packages/ai/src/providers/register-builtins.ts`
- `10-testing-and-contribution.md`
  - `npm run check` 的说明漏了根脚本实际会跑 `biome check --write --error-on-warnings`
- `12-compaction-comparison.md`
  - 把 compaction 目录说成 2 files 是错的，当前是 4 files
  - 自动 compaction 触发位置写成 `AgentSession.steer()` 不对，实际是 `_checkCompaction()`
  - `session_before_compact` 是扩展 hook，不是手动入口本身
  - `completeSimple` 被误写成“同步调用”
  - “Pi 不处理 thinking blocks” 与当前 token estimation 逻辑冲突
- `13-extended-feature-comparison.md`
  - 仍建议给 `beforeToolCall` 增加 `{ block, reason }`，但这两个字段在 core type 里早就存在
- `05-call-graph-and-dependencies.md`
  - 还残留 `Agent._runLoop` 的旧名字，应改成 `runPromptMessages()` → `runAgentLoop`
  - `pi-web-ui` / `pi-mom` 的依赖关系表述失真
  - `grep` / `find` 在调用图里被错误画成 bash `exec(...)`
  - `prepareToolCall` 图没有体现 `prepareToolCallArguments`
  - `transformContext` 的接线点在 `sdk.ts` 注入的函数里，最终调用 `ExtensionRunner.emitContext(messages)`；不是 `AgentSession._emitContext()`
- `03-coding-agent-layer.md`
  - `DefaultResourceLoader.reload()` 中冲突检测顺序描述仍需校准
  - 扩展加载顺序还缺 CLI precedence
- `02-agent-core-layer.md`
  - 对 `runAgentLoopContinue` 的前置条件解释比源码更强，需要收回来
- `07-extension-system-deep-dive.md`
  - `ExtensionContext.hasUI` 在 RPC 下也可以为 `true`
  - 生命周期图里应写 `loadExtensions()` / `loadExtensionFactories()`，不是 `discoverAndLoadExtensions()`
- `11-hands-on-exercises.md`
  - “prepare 串行 / execute 并发 / finalize 串行”的答案需要补上 `executionMode` 条件

## Final Audit Result
- 本轮针对高风险失真主题（`executionMode`、RPC `prompt` 语义、auth wiring、`find/grep` 参数、扩展重载顺序、RPC UI 能力、provider 命名）完成了回扫与修正
- 随后的第二轮独立深审又补掉了 API key 优先级、初始 prompt 事件、compaction 可观测性、telemetry 默认值等遗漏点
- 当前 `docs/study/**`、`docs/issue/**` 以及工作记忆文件在两轮独立复查后，均未再发现剩余的 material mismatch

## Follow-up From IM
- 用户在阶段性汇报后明确要求：**继续做一轮深入全面的 review**
- 因此不能把上一轮“高风险主题已清空”误当成“全树没有剩余问题”
- 下一轮策略应当改成：
  - 重新把 `docs/study/**`、`docs/issue/**` 分片独立审计
  - 尽量让第二轮审计不依赖第一轮的工作记忆结论
  - 只要发现新的源码-文档偏差，就继续最小化修补

## Deep Review Outcome
- 第二轮独立审计又抓到了几类首轮遗漏问题，并已继续修正：
  - `docs/study/03-coding-agent-layer.md` 的 API key 优先级次序写反
  - `docs/study/05-call-graph-and-dependencies.md` 漏了 `runAgentLoop()` 在进入 `runLoop()` 前对初始 prompt 发 `message_start` / `message_end`
  - `docs/study/11-hands-on-exercises.md` 对 `tool_call` 抛错、`convertToLlm()` exhaustiveness、`deepMergeSettings` 的解释过强
  - `docs/study/12-compaction-comparison.md` 把 `firstKeptEntryId` 写成“修改 session 文件顶层字段”，且把 Pi 的 compaction 可观测性简化成了完全没有
  - `docs/issue/architecture_comparison_deep_dive.md` 把 install telemetry 说成 opt-in；源码实际是 default-on / opt-out
  - `docs/issue/pi_issues_reproduction.md` 的 Issue 6 代码锚点和 Issue 11 的 `echo` 复现命令不稳
  - `docs/issue/pi_issues_final_evaluation.md`、`docs/issue/pi_issue_9_draft.md` 的 `executePreparedToolCall` 行号少了一行
  - `docs/issue/comparison_report.md` 仍写 `register-builtins.js`
- 第二轮修补后，再次用独立审计复查 `docs/study/00-07`、`docs/study/08-14`、`docs/issue/**`，均返回 **no remaining material mismatches**

## New Follow-up Direction
- 用户通过 `im_feedback` 选择继续补：`print/json/rpc` 模式的协议与事件契约
- 这块当前材料只在 `03-coding-agent-layer.md` 有概览，没有形成“对外接口 / JSON 事件形状 / RPC 生命周期 / 常见误判”的独立学习单元
- 新增内容应该优先回答：
  - JSON 模式实际输出的 event 形状是什么
  - 哪些字段在不同事件里存在 / 不存在（如 `tool_execution_end` 无 `args`）
  - `message_update.assistantMessageEvent` 和顶层 `AgentEvent` 的关系
  - print/json/rpc 三种模式各自面向什么使用场景
  - 这块内容在学习顺序上应该早于 interview 文档
- 额外确认的源码事实：
  - `main.ts` 的 `resolveAppMode()` 只有 `interactive` / `print` / `json` / `rpc` 四种 app mode；`--mode text` 出现在 CLI help，但真正进入非交互文本输出通常依赖 `-p` / `--print` 或非 TTY stdin
  - JSON print 模式会先输出 `sessionManager.getHeader()`（如果有），然后逐行输出 `AgentSessionEvent`
  - RPC 模式不会先吐 session header；它把 `response`、`AgentSessionEvent`、`extension_ui_request` 混在同一条 JSONL stdout 通道里
  - `toolcall_start` / `toolcall_end` 不属于顶层 `AgentEvent.type`，而是在 `message_update.assistantMessageEvent.type`
  - `tool_execution_end` 有 `toolCallId` / `toolName` / `result` / `isError`，没有 `args`
  - `output-guard.ts` 会在非 interactive 模式下接管 stdout，把普通 `console.log` 重定向到 stderr，保证机器可读 stdout 干净

## Interview Materials Follow-up
- 最新一轮 `im_feedback` 用户没有要求继续审源码一致性，而是明确要求：**整理面试材料**
- 现有 interview 相关内容的真实分布是：
  - `14-interview-introduction.md` 同时混着讲述稿、高频问答、试探题，已经开始失去焦点
  - `11-hands-on-exercises.md` 更适合“验证是否真懂”，不适合作为最后冲刺材料
  - `README.md` / `_sidebar.md` 只有学习顺序，没有面试冲刺顺序
- 因此最合理的整理方式不是继续往 `14` 里堆，而是三件套分层：
  - `14` 只保留“怎么讲项目”
  - `15` 提供一页速记版
  - `16` 提供按主题组织的问答库
- 这种拆法比单文件总包更适合最后复习，也更符合当前 `docs/study` 已经按功能分文档的结构
