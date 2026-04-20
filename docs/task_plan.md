# Task Plan

## Goal
继续清理 `docs/issue/**` 与 `docs/study/**` 中已经被最新代码推翻、漂移或不完整的内容，使其达到可用于学习和面试复述的正确性与细节密度。

## Scope
- 只修改 `docs/**`
- 不修改 `packages/**` 或仓库根目录文件
- `study/architecture-analysis` 视为长期存在的 fork 分支；代码基线持续跟踪最新 `origin/main`
- 该分支的长期定制差异原则上只保留在 `docs/**`
- 结束前或需要确认时调用 `im_feedback`

## Problem Statement
- `docs/issue/**` 中仍有一批 issue 分析/草稿文档混杂着旧 CLI、旧 API、旧行为结论。
- `docs/study/**` 虽已修过一批，但仍需继续核对剩余文档，确认逻辑链路、功能行为、并发/会话/扩展等叙述与最新源码一致。
- 这些文档的用途是学习和面试，所以“近似正确”不够，必须避免过时心智模型。

## Hypothesis
1. `docs/issue/**` 里最容易继续失真的，是 issue draft / final evaluation 中对 bug 现状、CLI 用法、修复状态的描述。
2. `docs/study/**` 里剩余未彻查文件主要集中在学习材料和综述类文档，容易残留旧符号名、旧实现假设和已修复问题。
3. 用 `origin/main` 对应源码做逐条对照，比基于现有文档互相引用更可靠。

## Phases
| Phase | Status | Description |
|---|---|---|
| 1 | complete | 重新建立 docs-only 工作内存，整理现状与优先级 |
| 2 | complete | 审计 `docs/issue/**` 中仍需维护的文档与最新代码/行为的一致性 |
| 3 | complete | 修复 `docs/issue/**` 中确认失真的内容 |
| 4 | complete | 审计 `docs/study/**` 全树剩余文档与最新代码的一致性 |
| 5 | complete | 修复 `docs/study/**` 中确认失真的内容 |
| 6 | complete | 复检所有改动，搜索旧符号/旧 CLI/旧事件名残留 |
| 7 | complete | 结束前调用 `im_feedback` 汇报结果并等待反馈 |
| 8 | complete | 补充 `print/json/rpc` 模式的协议与事件契约内容 |
| 9 | complete | 调整 `docs/study` 的章节/导航顺序，使新增内容落在合理位置 |
| 10 | complete | 结束前调用 `im_feedback` 汇报新增结果并等待反馈 |
| 11 | complete | 按新阅读顺序重排 `docs/study` 实际文件编号 |
| 12 | complete | 修正重编号后所有目录与跨文档引用 |
| 13 | complete | 结束前再次调用 `im_feedback` 汇报重编号结果并等待反馈 |
| 14 | complete | 处理 `fork/study/architecture-analysis` 旧远端分支的安全更新策略 |
| 15 | complete | 将长期分支维护原则写入 `study/architecture-analysis` 的 `CLAUDE.md` 并推送远端 |
| 16 | complete | 清理本地 `.worktrees` 下的临时隔离 worktree |
| 17 | complete | 清理 `/private/tmp/pi-mono-origin-main-docsync` 临时 worktree 残留 |
| 18 | complete | 将分支维护规则从根目录 `CLAUDE.md` 收回到 `docs/CLAUDE.md` 并推送远端 |
| 19 | complete | 修正本地主工作树分支仍追踪 `study/architecture-analysis-sync` 的错误状态 |
| 20 | complete | 针对最新 `origin/main` 增量审计 `docs/**` 是否再次失真 |
| 21 | complete | 合并最新 `origin/main` 后修正 compaction 相关 study 文档并推送分支 |
| 22 | complete | 针对最新 OpenAI prompt cache 上游变更再次审计并同步受影响文档 |
| 23 | complete | 再次全量审计 `docs/**` 与当前 `packages/**` 代码逻辑的一致性 |
| 24 | complete | 在首轮纠偏后再做一轮深入全面 review，寻找剩余隐藏失真并继续修正 |
| 25 | complete | 通过 `im_feedback` 收到“整理面试材料”反馈，并确认采用三件套分层整理方案 |
| 26 | complete | 收紧 `14` 为讲述版，新增 `15` 速记版与 `16` 问答库 |
| 27 | complete | 更新学习导航、复检新材料引用与一致性，并再次通过 `im_feedback` 获取下一步 |

## Priorities
1. 保持所有修改只在 `docs/**`
2. 优先修掉会误导学习者的“错误事实”，而不是文字润色
3. 对源码 line number 漂移，优先改成稳定的 symbol 引用
4. 对 issue 文档，明确区分“仍成立的问题”和“已失效的旧判断”
5. 后续同步默认直接维护 `fork/study/architecture-analysis` 本身；临时分支只作为保险，不作为主线

## Errors Encountered
| Error | Attempt | Resolution |
|---|---|---|
| 上轮任务中用户通过 IM 反馈收窄为 `docs/**` only | 1 | 本轮将工作内存文件也放入 `docs/`，并限制所有编辑到 `docs/**` |
| 误把 “Pi 完全没有 tool-level `executionMode`” 当成当前事实 | 2 | 重新核对 `packages/agent/src/agent-loop.ts` 与 `packages/agent/src/types.ts`，确认 `AgentTool` 已有 `executionMode` 字段，但当前 runtime 只把 `sequential` 用作整批回退开关，并据此批量修正文档与工作记忆 |
