# Pi-Mono 代码学习指南

针对 pi-mono 项目架构的深度分析，目标：理解项目设计，准备贡献 PR。

## 文档目录

| # | 文档 | 内容 |
|---|------|------|
| 00 | [架构总览](00-architecture-overview.md) | 三层设计、数据流、事件系统、工具生命周期 |
| 01 | [pi-ai 层](01-pi-ai-layer.md) | 类型系统、EventStream、流式调用、Provider 模式 |
| 02 | [agent-core 层](02-agent-core-layer.md) | 双循环、工具执行、Agent 类、消息扩展 |
| 03 | [coding-agent 层](03-coding-agent-layer.md) | CLI、运行模式、AgentSession、工具、扩展、压缩、会话、配置、资源加载、Skills、包管理 |
| 04 | [print/json/rpc 模式与事件契约](04-print-json-rpc-protocol-and-event-contracts.md) | 非交互模式分流、stdout/stderr 契约、JSONL 形状、RPC 请求/响应生命周期、事件层次与常见误判 |
| 05 | [调用图和依赖关系](05-call-graph-and-dependencies.md) | 完整调用链、抽象边界、文件依赖 |
| 06 | [工具系统深入](06-tool-system-deep-dive.md) | 7 个工具的完整执行流程、匹配算法、截断策略 |
| 07 | [扩展系统深入](07-extension-system-deep-dive.md) | Extension API、事件系统、Runner、加载机制、真实示例 |
| 08 | [压缩与会话管理](08-compaction-and-sessions.md) | 上下文压缩、Token 估算、会话树、分支、持久化 |
| 09 | [设计模式与贡献指南](09-design-patterns-and-contribution-guide.md) | 设计模式、反模式、贡献清单 |
| 10 | [测试与贡献工作流](10-testing-and-contribution.md) | 测试框架、运行方式、贡献流程、验证清单 |
| 11 | [实战练习](11-hands-on-exercises.md) | 23 个动手练习 + 10 题综合测验，验证学习效果 |
| 12 | [Compaction 深度对比](12-compaction-comparison.md) | Claude Code vs Pi 的压缩机制、触发策略、摘要生成、补水与错误恢复对比 |
| 13 | [扩展功能对比](13-extended-feature-comparison.md) | Claude Code vs Pi 在 hooks、MCP、plans、session restore、cost tracker 等能力上的对比 |
| 14 | [面试介绍文档](14-interview-introduction.md) | 30 秒 / 90 秒 / 5 分钟版本的项目介绍话术、亮点、限制与结尾模板 |
| 15 | [面试速记版](15-interview-cheat-sheet.md) | 一页内压缩架构、调用链、亮点、限制与高风险易错点 |
| 16 | [面试问答库](16-interview-question-bank.md) | 按主题整理的标准答法、追问与“面试官在试探什么” |

## 建议阅读顺序

1. 先读 **00-架构总览** 建立全局概念
2. 按 **01 → 02 → 03** 逐层深入（ai → agent → coding-agent）
3. 紧接着读 **04**，把 `print/json/rpc` 的协议层和事件层次讲明白
4. 再用 **05** 作为追踪调用链和依赖关系的参考手册
5. 按 **06 → 07 → 08** 深入工具、扩展、会话/压缩三个子系统
6. 读 **09 → 10**，补上设计模式、测试和贡献工作流
7. 完成 **11** 的实战练习验证理解
8. 补读 **12 / 13** 做横向比较，帮助形成“Pi 为什么这样设计、缺了什么、又故意没做什么”的面试表达
9. 面试前先读 **15**，把全局地图、亮点、限制和易错点压缩成速记
10. 再读 **14**，练 30 秒 / 90 秒 / 5 分钟讲述
11. 最后刷 **16**，专门防追问

## 面试冲刺顺序

如果你的目标从“系统学习”切换成“准备面试”，不要再线性重读全套文档。直接按这个顺序：

1. `15-interview-cheat-sheet.md` — 快速校准事实边界
2. `14-interview-introduction.md` — 练项目介绍
3. `16-interview-question-bank.md` — 防深挖
4. `11-hands-on-exercises.md` — 只挑你最没把握的题抽查

## 配套源码

学习每层时，同时打开这些源文件对照阅读：

### Layer 1（pi-ai）
- `packages/ai/src/types.ts` — 所有核心类型定义
- `packages/ai/src/utils/event-stream.ts` — EventStream 实现
- `packages/ai/src/stream.ts` — 流式调用入口

### Layer 2（agent-core）
- `packages/agent/src/types.ts` — AgentMessage、AgentTool 定义
- `packages/agent/src/agent-loop.ts` — 主循环（最核心的文件）
- `packages/agent/src/agent.ts` — Agent 类公共 API

### Layer 3（coding-agent）
- `packages/coding-agent/src/core/tools/edit.ts` — 编辑工具实现
- `packages/coding-agent/src/core/messages.ts` — 自定义消息类型
- `packages/coding-agent/src/core/agent-session.ts` — 会话编排器
- `packages/coding-agent/src/core/system-prompt.ts` — 系统提示词构建
- `packages/coding-agent/src/core/compaction/compaction.ts` — 压缩逻辑
- `packages/coding-agent/src/core/session-manager.ts` — 会话管理
- `packages/coding-agent/src/core/extensions/types.ts` — 扩展 API 类型
