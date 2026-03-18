# Pi-Mono 代码学习指南

针对 pi-mono 项目架构的深度分析，目标：理解项目设计，准备贡献 PR。

## 文档目录

| # | 文档 | 内容 |
|---|------|------|
| 00 | [架构总览](00-architecture-overview.md) | 三层设计、数据流、事件系统、工具生命周期 |
| 01 | [pi-ai 层](01-pi-ai-layer.md) | 类型系统、EventStream、流式调用、Provider 模式 |
| 02 | [agent-core 层](02-agent-core-layer.md) | 双循环、工具执行、Agent 类、消息扩展 |
| 03 | [coding-agent 层](03-coding-agent-layer.md) | CLI、运行模式、AgentSession、工具、扩展、压缩、会话、配置、资源加载、Skills、包管理 |
| 04 | [调用图和依赖关系](04-call-graph-and-dependencies.md) | 完整调用链、抽象边界、文件依赖 |
| 05 | [工具系统深入](05-tool-system-deep-dive.md) | 7 个工具的完整执行流程、匹配算法、截断策略 |
| 06 | [扩展系统深入](06-extension-system-deep-dive.md) | Extension API、事件系统、Runner、加载机制、真实示例 |
| 07 | [压缩与会话管理](07-compaction-and-sessions.md) | 上下文压缩、Token 估算、会话树、分支、持久化 |
| 08 | [设计模式与贡献指南](08-design-patterns-and-contribution-guide.md) | 设计模式、反模式、贡献清单 |
| 09 | [测试与贡献工作流](09-testing-and-contribution.md) | 测试框架、运行方式、贡献流程、验证清单 |
| 10 | [实战练习](10-hands-on-exercises.md) | 23 个动手练习 + 10 题综合测验，验证学习效果 |

## 建议阅读顺序

1. 先读 **00-架构总览** 建立全局概念
2. 按 **01 → 02 → 03** 逐层深入（ai → agent → coding-agent）
3. 用 **04** 作为追踪代码路径的参考手册
4. 按 **05 → 06 → 07** 深入各子系统
5. 读 **08** 了解设计模式和反模式
6. 读 **09** 了解测试和贡献工作流
7. 最后完成 **10** 的实战练习验证理解

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
