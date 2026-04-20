# Phase 5: 测试架构与贡献工作流

## 测试框架

| 包 | 框架 | 配置 |
|---|------|------|
| pi-ai | Vitest | `packages/ai/vitest.config.ts` |
| agent-core | Vitest | `packages/agent/vitest.config.ts` |
| coding-agent | Vitest | `packages/coding-agent/vitest.config.ts` |
| tui | Node.js 内置测试 | `node --test` |

Vitest 配置:
- `globals: true`（describe、it、expect 全局可用）
- `environment: 'node'`
- `testTimeout: 30000`（30 秒，适应 API 调用）

## 测试目录结构

下面的目录树是**代表性样本**，不是 `packages/ai/test/` / `packages/coding-agent/test/` 的完整穷举。

```
packages/ai/test/
├── stream.test.ts          — 流式调用测试
├── tokens.test.ts          — Token 计算
├── abort.test.ts           — 中止处理
├── context-overflow.test.ts — 上下文溢出
├── cross-provider-handoff.test.ts — 跨 Provider 交接
├── bedrock-utils.ts        — Bedrock 凭证工具
└── oauth.ts                — OAuth 凭证解析

packages/agent/test/
├── agent-loop.test.ts      — 主循环测试
├── e2e.test.ts             — 端到端测试
└── ...

packages/coding-agent/test/
├── tools.test.ts           — 工具单元测试
├── compaction.test.ts       — 压缩测试
├── extensions-runner.test.ts — 扩展运行器测试
├── extensions-discovery.test.ts — 扩展发现测试
├── agent-session-dynamic-tools.test.ts — 动态工具测试
├── session-manager/         — 会话管理器测试
├── utilities.ts             — 测试工具函数
└── fixtures/                — 测试数据
    ├── large-session.jsonl
    ├── before-compaction.jsonl
    └── skills/
```

## 测试模式

### 基本模式

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("edit tool", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "edit-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("should replace text in file", async () => {
    const filePath = join(tempDir, "test.txt")
    writeFileSync(filePath, "hello world")

    const tool = createEditTool(tempDir)
    const result = await tool.execute("id", {
      path: "test.txt",
      edits: [{ oldText: "hello", newText: "goodbye" }]
    })

    expect(result.content[0].text).toContain("Successfully")
    expect(readFileSync(filePath, "utf-8")).toBe("goodbye world")
  })
})
```

### 条件跳过（需要 API Key 的测试）

```typescript
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic provider", () => {
  it("should stream response", async () => {
    // 需要真实 API key 才能运行
  })
})
```

### Mock 模式

```typescript
import { vi } from "vitest"

vi.mock("child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({
    stdout: Buffer.from("file1.ts\nfile2.ts"),
    status: 0
  })
}))
```

### 测试工具函数 (coding-agent/test/utilities.ts)

```typescript
// 解析凭证
resolveApiKey(provider)         // 从 ~/.pi/agent/auth.json 加载
hasAuthForProvider(provider)    // 检查是否有凭证

// 创建测试会话
createTestSession(options)      // 完整 AgentSession（含真实 LLM）
createTestResourceLoader()      // stub 资源加载器

// 消息辅助
userMsg(text)                   // 创建 UserMessage
assistantMsg(text)              // 创建 AssistantMessage

// 会话树构建
buildTestTree(session, structure) // 构建测试用会话树
```

## 如何运行测试

### 开发过程中：运行特定测试

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/tools.test.ts
```

### 提交前：运行检查

```bash
npm run check
```

`npm run check` 做了什么:
1. **Biome** — lint + 自动写回格式修复（`--write --error-on-warnings`）
2. **tsgo --noEmit** — TypeScript 类型检查
3. **check:browser-smoke** — 浏览器构建冒烟测试
4. **packages/web-ui check** — web-ui 包的检查

**注意**: `npm run check` **不运行测试**。它只做静态检查。

### PR 前：运行全部测试

```bash
./test.sh
```

`test.sh` 做了什么:
1. 备份 `~/.pi/agent/auth.json`（退出时恢复）
2. 设置 `PI_NO_LOCAL_LLM=1`（跳过本地 LLM 测试）
3. 清除所有 provider API key 环境变量
4. 运行 `npm test`（所有包的测试）

因为 API key 被清除，依赖真实 API 的测试被 `describe.skipIf` 跳过。

### 不同场景的运行策略

| 场景 | 命令 | 说明 |
|------|------|------|
| 修改一个工具后 | `npx tsx ... --run test/tools.test.ts` | 只运行相关测试 |
| 修改类型后 | `npm run check` | 类型检查确认没有破坏 |
| 准备提交 | `npm run check` | 必须无错误/警告 |
| 准备 PR | `./test.sh` | 全量测试 |

## 贡献工作流

### 完整流程

```
1. 发现问题或想法
   │
   ▼
2. 开 GitHub Issue
   - 描述改动和原因
   - 保持简短
   - 使用你自己的语言风格
   - 添加相关的 pkg:* 标签
   │
   ▼
3. 等待 maintainer 回复 `lgtm`
   - 拿到 `lgtm` 后再继续准备 PR
   - 不要在获得认可前就开始写代码
   │
   ▼
4. 实现改动
   - 确定影响哪一层（ai / agent / coding-agent）
   - 遵循代码风格（无 any、无 inline import、TypeBox schema）
   - 写测试
   │
   ▼
5. 本地验证
   a. npm run check  — 无错误/警告
   b. ./test.sh      — 全部通过
   │
   ▼
6. 提交
   - git add <specific-files>（不用 git add -A）
   - 不编辑 CHANGELOG.md
   - commit message 含 "fixes #N" 或 "closes #N"
   │
   ▼
7. 推送到 fork，创建 PR
   - 描述改动
   - 引用 issue
   │
   ▼
8. 等待 review
```

### 关键规则

| 规则 | 原因 |
|------|------|
| 先开 issue，等 `lgtm` | 避免在方向未被接受时过早投入实现 |
| `npm run check` 无错误 | 静态检查是提交的最低门槛 |
| `./test.sh` 全通过 | 确保不破坏现有功能 |
| 不编辑 CHANGELOG.md | maintainer 在 release 时统一更新 |
| `git add <specific-files>` | 单仓多 agent 并行工作，避免提交别人的改动 |
| 不用 `git add -A` / `git commit --no-verify` | 同上 |

### npm run check 失败怎么办

```
1. Biome 错误 → 通常是格式问题
   - biome check --write . 会自动修复大多数问题
   
2. TypeScript 错误 → 类型不匹配
   - 检查 node_modules 的类型定义（不要猜 API）
   - 不要用 any 逃避类型检查
   
3. browser-smoke 失败 → 浏览器兼容性问题
   - 检查是否引入了 Node-only 依赖
```

### 测试失败怎么办

```
1. 确认是你的改动导致的
   - git stash → ./test.sh → git stash pop
   
2. 如果是你导致的:
   - 运行特定失败的测试文件调试
   - 检查是否影响了共享的类型或接口
   
3. 如果不是你导致的:
   - 可能是 flaky test 或环境问题
   - 在 PR 中说明
```

## 测试分类

| 类型 | 位置 | 特点 |
|------|------|------|
| **单元测试** | 大多数 `*.test.ts` | 纯函数、工具、工具函数 |
| **集成测试** | `stream.test.ts`、`agent-loop.test.ts` | 调用真实或 mock API |
| **端到端测试** | `agent/test/e2e.test.ts` | 完整 agent 运行 |
| **API 依赖测试** | `ai/test/` 中的 provider 测试 | `describe.skipIf` 保护 |

### 测试覆盖策略

- **工具测试**: 每个工具的 happy path + 错误场景
- **压缩测试**: 触发条件、切割点、摘要格式
- **扩展测试**: 发现规则、冲突检测、错误处理
- **会话测试**: 分支、导航、持久化、恢复
- **Provider 测试**: 流式传输、中止、错误编码
