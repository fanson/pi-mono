# Progress Log

## 2026-04-20

### Session Restart
- 重新读取：
  - `planning-with-files` skill
  - `AGENTS.md`
  - `study-docs-sync.mdc`
  - `im-feedback.mdc`
- 运行 `opencli list`
- 确认当前工作树仅保留 `docs/**` 下的改动

### Current Status
- 用户要求继续更新 `docs/issue/**`
- 同时继续检查 `docs/study/**` 与最新代码的逻辑/功能一致性
- 文档将用于学习和面试，因此本轮标准是“正确且详细”，而不是“可读即可”
- 已在 `docs/` 下重建 planning files，保持 docs-only 约束
- 已完成三路并行审计：
  - `docs/issue` drafts / final evaluation / reproduction
  - `docs/study` 剩余高层学习文档（README、08、09、11、12）
  - 已修过的 study 文档复核
- 新发现的剩余问题已记录到 `docs/findings.md`
- 下一步进入逐文件修复阶段

### Late Verification Pass
- 追加做了只读交叉审计，专门核对：
  - `docs/issue/pi_issues_proposal.md`
  - `docs/issue/pi_issues_reproduction.md`
  - `docs/issue/pi_issues_final_evaluation.md`
  - `docs/issue/comparison_report.md`
  - `docs/issue/architecture_comparison_deep_dive.md`
  - `docs/issue/claude_code_interview_deep_dive.md`
  - `docs/study/02-agent-core-layer.md`
  - `docs/study/05-call-graph-and-dependencies.md`
- 发现并纠正了一条高风险误判：**Pi 并非完全没有 per-tool `executionMode`**；当前 runtime 已支持 coarse 的 tool-level sequential override，但仍没有 Claude Code 式分区调度
- 由此回滚/修正了此前写进 `docs/issue/**`、`docs/study/**` 与 planning files 的错误结论
- 又额外修掉两处剩余 material mismatch：
  - `comparison_report.md`：compaction 触发时机与 compaction hooks 描述不完整
  - `study/05-call-graph-and-dependencies.md`：`transformContext` 接线位置画错
- 当前进入最终复检阶段：搜索残余旧说法、检查改动一致性、准备结束前的 `im_feedback`

### Final Sweep Completed
- 对 `docs/issue/**` 做了全树只读审计，结论：**no remaining material mismatches found in docs/issue**
- 对 `docs/study/**` 做了全树只读审计，并继续修掉最后几轮发现的 API / 签名 / 贡献流程 / 模型解析口径错误，最终结论：**no remaining material mismatches found in docs/study**
- 新增 `docs/study/14-interview-introduction.md`
  - 提供 30 秒 / 90 秒 / 5 分钟版本介绍
  - 总结亮点、限制、高频问题和“不要讲错的点”
  - 追加一组“试探你是否真的懂”的追问题，专门覆盖 hooks、toolExecution、compaction、model resolver、事件 payload、贡献 gate 等细节
- 同步更新：
  - `docs/study/README.md`
  - `docs/study/_sidebar.md`

### Follow-up After IM
- 用户继续要求补充遗漏内容，并通过 `im_feedback` 选择优先深挖：`print/json/rpc` 模式的协议与事件契约
- 当前任务转入新阶段：
  - 先审计 `packages/coding-agent/src/modes/print-mode.ts` / `rpc/` / `main.ts` / 事件类型定义
  - 再决定是补进现有章节，还是新增独立 study 文档
  - 最后重排 `docs/study` 导航顺序，让协议契约内容放在合理位置

### Protocol Research Status
- 已完成对以下源码 / 官方文档的核对：
  - `packages/coding-agent/docs/json.md`
  - `packages/coding-agent/docs/rpc.md`
  - `packages/coding-agent/src/modes/print-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
  - `packages/coding-agent/src/modes/rpc/jsonl.ts`
  - `packages/coding-agent/src/core/output-guard.ts`
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/agent/src/types.ts`
  - `packages/ai/src/types.ts`
- 已确认：这块内容值得做成**独立 study 文档**，而不是继续塞进 `03-coding-agent-layer.md`
- 下一步：新增独立章节，主题聚焦 `print/json/rpc` 的协议、事件层次和常见误判；随后重排目录顺序

### Protocol Chapter Added
- 新增 `docs/study/04-print-json-rpc-protocol-and-event-contracts.md`
  - 覆盖 app mode 分流、stdout takeover、print text/json 差异、RPC request/response/event 三层、Extension UI 子协议
  - 明确 `toolcall_*` vs `tool_execution_*`、`tool_execution_end` 无 `args`、JSON 首行 session header 与事件流不是同一层
  - 补上 `--mode text` 在实现层的真实含义，避免把 CLI help 文案当成 app mode 真相
- 已调整导航顺序：
  - `docs/study/README.md`
  - `docs/study/_sidebar.md`
- 当前新增章节被放在 `03-coding-agent-layer.md` 之后、`05-call-graph-and-dependencies.md` 之前，作为“从产品层概览过渡到协议/事件细节”的桥接章节

### IM Feedback: Renumber Files
- `im_feedback` 已成功发送，本轮收到明确反馈：**重新调整文档编号顺序**
- 这意味着不能只改 README / sidebar 展示顺序，而要把 `docs/study` 的实际文件编号重排
- 当前计划：
  - 先按目标顺序重命名 `04` 之后的 study 文档
  - 再全局搜索并修正 README、sidebar 以及文档内部的文件链接/章节编号引用

### Renumbering Completed
- 已将新增协议章节正式纳入编号序列：
  - `04-print-json-rpc-protocol-and-event-contracts.md`
  - 原 `04` 到 `13` 顺次后移为 `05` 到 `14`
- 已同步修正：
  - `docs/study/README.md`
  - `docs/study/_sidebar.md`
  - `docs/study/02-agent-core-layer.md`
  - `docs/study/03-coding-agent-layer.md`
  - `docs/study/04-print-json-rpc-protocol-and-event-contracts.md`
- 已再次全局搜索 `docs/**`，确认不再残留旧编号文件链接

### Commit / Push Result
- 已创建 commit：`a1d4dbdd` — `docs: sync Pi study docs with current runtime behavior`
- pre-commit hook 已自动跑完仓库 check，全部通过
- 推送结论：
  - `origin` 指向 upstream（`badlogic/pi-mono`），当前账号无写权限
  - `fork` 才是可写 fork remote（`fanson/pi-mono`）
  - `fork/study/architecture-analysis` 已存在分叉历史，不能 fast-forward
  - 为避免 force push，当前成果已安全推到新分支：`fork/study/architecture-analysis-sync`
- 本地分支 `study/architecture-analysis` 现已跟踪 `fork/study/architecture-analysis-sync`

### Latest IM Feedback
- 用户进一步追问：如何安全更新 `fork/study/architecture-analysis` 旧分支的内容，确保基于最新代码再准确提交

### Safe Update of `fork/study/architecture-analysis`
- 按用户确认，使用项目内 `.worktrees/`
- 发现 `.worktrees` 未被忽略；为避免修改 tracked `.gitignore`，将忽略规则写入 repo-local `.git/info/exclude`
- 创建隔离 worktree：`/Users/haiyangzhou/work/pi-mono/.worktrees/update-study-architecture-analysis`
- 在隔离分支上执行：
  - `git merge origin/main`
  - `git restore --source a1d4dbdd --worktree --staged -- docs/issue docs/study`
  - `git commit` 生成 `bbeaec57` — `docs: resync study branch on latest main`
- 为让验证环境与 merge 后 lockfile 一致，在隔离 worktree 内执行了 `npm install`
- 验证：
  - `npm run check` 通过
  - `git push fork HEAD:study/architecture-analysis` 成功
- 最终结果：
  - `fork/study/architecture-analysis` 已从 `f09537de` 更新到 `bbeaec57`
  - 这是一次 **non-force fast-forward** 更新
  - 分支内容现在建立在最新 `origin/main` 基线之上，同时保留了已验证的 docs 最终状态

### Long-lived Branch Model Confirmed
- 用户明确确认长期目标：
  - `study/architecture-analysis` 分支应长期存在
  - 代码持续跟踪最新 `origin/main`
  - 持续演进的是 `docs/**` 下的学习/面试材料
- 这意味着后续默认策略不再是“做完一次文档同步就关掉分支”，而是把该分支当作稳定的 docs overlay 主线维护

### Branch Rule Persisted
- 在 `fork/study/architecture-analysis` 对应的隔离 worktree 中新增根文件 `CLAUDE.md`
- 内容聚焦于 branch-specific 原则，而不是复制 `AGENTS.md`
- 已创建并推送 commit：`c3c07e0b` — `docs: add branch maintenance guide for study overlay`
- pre-commit hook 再次通过仓库 `npm run check`
- 该规则现已存在于远端长期分支本身，可供后续会话直接继承

### Local `.worktrees` Cleanup
- 已移除本地隔离 worktree：`/Users/haiyangzhou/work/pi-mono/.worktrees/update-study-architecture-analysis`
- 空的 `.worktrees/` 目录也已删除
- 说明：仓库仍存在一个更早创建在 `/private/tmp/pi-mono-origin-main-docsync` 的独立 worktree；本次用户只要求清理本地 `.worktrees`，因此未动该临时路径

### `/private/tmp` Worktree Cleanup
- 已确认 `/private/tmp/pi-mono-origin-main-docsync` 为干净的 detached HEAD worktree
- 已执行 `git worktree remove /private/tmp/pi-mono-origin-main-docsync`
- 当前 `git worktree list` 只剩主工作树：`/Users/haiyangzhou/work/pi-mono`

### Move Branch Rule Into `docs/`
- 用户要求把之前的根目录 `CLAUDE.md` 收回到 `docs/`
- 在新的隔离 worktree 中完成：
  - `CLAUDE.md` → `docs/CLAUDE.md`
  - 保留同一组 branch-specific 原则，但把措辞改成 docs overlay 语境
- 已创建并推送 commit：`f8712a25` — `docs: move branch maintenance guide under docs`
- 临时 worktree `.worktrees/move-claude-to-docs` 已再次清理；当前 `git worktree list` 仍只剩主工作树

### Fix Local Branch Tracking Mismatch
- 用户指出主工作树仍显示 `study/architecture-analysis...fork/study/architecture-analysis-sync`，同时 `docs/CLAUDE.md` 不可见
- 根因确认：
  - 主工作树仍停在旧本地分支提交 `a1d4dbdd`
  - upstream 仍指向 `fork/study/architecture-analysis-sync`
  - 远端真实最新分支是 `fork/study/architecture-analysis`，其提交为 `f8712a25`
- 由于本地旧分支与远端主线历史分叉，不适合硬做 fast-forward 或造一个无意义的 merge commit
- 采用的安全修复：
  - 将旧本地分支改名为 `study/architecture-analysis-local-backup`
  - 重新创建本地 `study/architecture-analysis` 并跟踪 `fork/study/architecture-analysis`
- 修复后：
  - 主工作树当前分支为 `study/architecture-analysis`
  - upstream 正确指向 `fork/study/architecture-analysis`
  - `docs/CLAUDE.md` 已在当前工作树可见

### New Upstream Audit Trigger
- 用户提示 `origin/main` 又有更新，并要求遵循 `docs/CLAUDE.md` 再次检查 `docs/**` 是否需要同步
- 已先做增量取证：
  - 新提交仅 3 个：`fix(tui): restore shifted xterm input`、`fix(coding-agent): reuse session thinking for compaction`、`fix(coding-agent): add missing typebox dependency`
  - upstream 删除 branch-private `docs/**` 与 `.cursor/rules/study-docs-sync.mdc` 不作为“本分支 docs 应删除”的证据
- 初步结论：
  - 主要文档风险集中在 compaction 相关材料
  - TUI 修复更像实现层行为修正，当前 study 文档未必需要同步到按键序列细节

### Upstream Delta Synced Again
- 已按 `docs/CLAUDE.md` 流程执行：
  - 创建隔离 worktree `.worktrees/upstream-docs-audit`
  - 合并最新 `origin/main`
  - 仅修复确认失真的 study 文档
- 本轮 upstream 的 material doc impact 只落在 compaction 行为：
  - `AgentSession` 现在把 `thinkingLevel` 传给 compaction
  - `generateSummary()` / `generateTurnPrefixSummary()` 不再固定 `reasoning: "high"`
- 已更新：
  - `docs/study/08-compaction-and-sessions.md`
  - `docs/study/12-compaction-comparison.md`
- 未更新：
  - TUI shifted xterm input 修复未在现有 study 文档形成事实性失真
  - typebox 依赖补声明不构成当前 study 文档的 material mismatch
- 验证：
  - 初次 `npm run check` 因 worktree 依赖环境未对齐而失败（缺 `uuid` / `@mistralai` / anthropic type mismatch）
  - 在隔离 worktree 内执行 `npm install` 后，`npm run check` 通过
- 已创建并推送 commit：`3ee67372` — `docs: update study docs for upstream changes`
- 主工作树已 fast-forward 到 `3ee67372`
- 临时 worktree `.worktrees/upstream-docs-audit` 已清理；当前 `git worktree list` 只剩主工作树

### OpenAI Prompt Cache Delta Synced
- 上游再次新增 `aa1b587b`：`fix(ai): add direct OpenAI completions prompt caching`
- 审计结论：
  - material impact 只落在 `docs/study/01-pi-ai-layer.md`
  - 现有 Prompt Cache 提供商表把 OpenAI 缓存实现只映射到 `openai-responses.ts`，对最新代码而言已不完整
- 已在隔离 worktree `.worktrees/openai-cache-audit` 中完成：
  - 合并最新 `origin/main`
  - 更新 `docs/study/01-pi-ai-layer.md`
    - Prompt Cache 支持表补充 `openai-completions.ts`
    - 明确仅直连官方 `api.openai.com` 时会注入这些字段
- 验证：
  - 初次 `npm run check` 仍因 worktree 依赖环境未对齐而失败
  - 在该 worktree 内执行 `npm install` 后，`npm run check` 通过
- 已创建并推送 commit：`b813bcaf` — `docs: update study docs for upstream changes`
- 主工作树已 fast-forward 到 `b813bcaf`
- 临时 worktree `.worktrees/openai-cache-audit` 已清理；当前 `git worktree list` 只剩主工作树

### Full Docs Audit Refresh
- 再次全量回扫 `docs/**` 与当前 `packages/**` 后，补修了这一轮仍会误导学习者的高风险失真：
  - `executionMode`：从“完全不存在”改回“已存在 coarse sequential override，但没有分区批处理”
  - RPC `prompt`：从“立即 success”改回“preflight 成功后才输出 success”
  - auth wiring：`createAgentSession()` 在 `streamFn` 内调用 `modelRegistry.getApiKeyAndHeaders(model)`，不是单独的 `getApiKey` 回调
  - 事件顺序：`_handleAgentEvent()` 里是扩展先看见事件，再通知 listeners，`message_end` 时才持久化
  - 工具参数：`grep` / `find` 的 `rg` / `fd` 参数与输出格式更新到当前实现
  - 扩展重载：`ResourceLoader.reload()` / RPC UI 生命周期图改回当前真实路径
- 本轮实际更新文件：
  - `docs/study/00-architecture-overview.md`
  - `docs/study/02-agent-core-layer.md`
  - `docs/study/03-coding-agent-layer.md`
  - `docs/study/04-print-json-rpc-protocol-and-event-contracts.md`
  - `docs/study/05-call-graph-and-dependencies.md`
  - `docs/study/06-tool-system-deep-dive.md`
  - `docs/study/07-extension-system-deep-dive.md`
  - `docs/study/11-hands-on-exercises.md`
  - `docs/study/14-interview-introduction.md`
  - `docs/issue/architecture_comparison_deep_dive.md`
  - `docs/issue/comparison_report.md`
  - `docs/issue/pi_issues_reproduction.md`
  - `docs/issue/pi_issues_final_evaluation.md`
  - `docs/issue/pi_issues_proposal.md`
- 随后用关键词回扫这些主题的旧说法，未再发现残留 mismatch

### IM Feedback After Refresh
- 通过 `im_feedback` 汇报了这一轮纠偏结果
- 用户反馈不是“结束”，而是：**继续做一轮深入全面的 review**
- 因此当前状态不是收尾，而是进入第二轮独立审计：
  - 重新分片审计 `docs/study/**`
  - 重新分片审计 `docs/issue/**`
  - 把上一轮已经修过的主题当成“已知风险”，但不把它们当作“默认已经彻底清空”

### Deep Review Completed
- 第二轮独立审计实际又抓到了几处首轮遗漏：
  - `study/03`：API key 优先级顺序写反
  - `study/05`：`runAgentLoop()` 进入 `runLoop()` 前缺少初始 prompt 的 `message_start` / `message_end`
  - `study/11`：`tool_call` 抛错、`convertToLlm()` exhaustiveness、`deepMergeSettings` 的解释过强
  - `study/12`：`firstKeptEntryId` 的持久化位置写错，且把 Pi 的 compaction 可观测性简化成了“没有”
  - `issue/architecture_comparison_deep_dive.md`：install telemetry 默认值写错
  - `issue/pi_issues_reproduction.md`：Issue 6 代码锚点与 Issue 11 复现命令不稳
  - `issue/pi_issues_final_evaluation.md`、`issue/pi_issue_9_draft.md`：`executePreparedToolCall` 行号偏一行
  - `issue/comparison_report.md`：`register-builtins.js` 路径过时
- 完成第二批修补后，再次让三路独立审计复查：
  - `docs/study/00-07` → `no remaining material mismatches`
  - `docs/study/08-14` → `no remaining material mismatches`
  - `docs/issue/**` + planning files → `no remaining material mismatches`

### Interview Materials Pack
- 按规则先通过 `im_feedback` 汇报深审完成情况
- 用户最新反馈不是结束，而是：**整理面试材料**
- 先盘点现有 interview 相关材料：
  - `14-interview-introduction.md` 同时承担讲述稿、高频问答、试探题，焦点过宽
  - `11-hands-on-exercises.md` 更适合自测，不适合作为冲刺入口
  - `README.md` / `_sidebar.md` 缺少面试冲刺顺序
- 之后通过结构化确认收敛方案，用户明确选择：**方案 2：三件套分层整理**
- 已完成的整理动作：
  - 重写 `docs/study/14-interview-introduction.md`，让它只负责“怎么讲项目”
  - 新增 `docs/study/15-interview-cheat-sheet.md`，压缩架构、调用链、亮点、限制和易错点
  - 新增 `docs/study/16-interview-question-bank.md`，按主题整理标准答法、追问和试探点
  - 更新 `docs/study/README.md`，新增面试冲刺顺序
  - 更新 `docs/study/_sidebar.md`，纳入 `15` / `16`
- 复检结果：
  - 新文档已被 `README.md` / `_sidebar.md` 正确引用
  - `ReadLints` 未报告新增问题
- 最新 `im_feedback` 已收到下一步明确指令：**提交并推送**
