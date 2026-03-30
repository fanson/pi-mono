# Phase 2: 工具系统深入分析

## 工具总览

coding-agent 提供 7 个工具，分为三组：

```
编辑组（可写）:
  edit  — 精确文本替换（read→match→replace→write）
  write — 创建/覆写文件
  bash  — 执行 shell 命令

探索组（只读）:
  read  — 读取文件内容（支持图片）
  grep  — 搜索文件内容（依赖 ripgrep）
  find  — 按 glob 查找文件（依赖 fd）
  ls    — 列出目录内容
```

| 函数 | 返回类型 | 包含工具 |
|------|----------|----------|
| `createCodingToolDefinitions(cwd)` | `ToolDefinition[]` | read, bash, edit, write |
| `createReadOnlyToolDefinitions(cwd)` | `ToolDefinition[]` | read, grep, find, ls |
| `createAllToolDefinitions(cwd)` | `Record<ToolName, ToolDefinition>` | 全部 7 个 |
| `createCodingTools(cwd)` | `AgentTool[]` | read, bash, edit, write |
| `createReadOnlyTools(cwd)` | `AgentTool[]` | read, grep, find, ls |
| `createAllTools(cwd)` | `Record<ToolName, AgentTool>` | 全部 7 个 |

### Definition-first 架构

每个工具现在有两层 API：

```
ToolDefinition（底层）:
  - prompt 元数据（name, description, parameters schema）
  - execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)
  - 可选: renderCall, renderResult（TUI 渲染）
  - 可选: prepareArguments(rawArgs) — 在 schema 验证前规范化参数

AgentTool（运行时层）:
  - 通过 wrapToolDefinition(definition, ctxFactory?) 包装
  - ctxFactory 注入 ExtensionContext（来自 ExtensionRunner.createContext()）
```

`wrapToolDefinition` 在 `tool-definition-wrapper.ts` 中实现。
扩展注册的工具通过 `wrapRegisteredTool(registeredTool, runner)` 包装，
自动注入 runner 的上下文工厂。

## 共享基础设施

> **源码对照**: `packages/coding-agent/src/core/tools/path-utils.ts` — resolveReadPath L62, resolveToCwd L54, expandPath L39

### 路径解析

两个函数，用途不同：

```
resolveToCwd(path, cwd):
  - 支持 ~ 展开
  - path.resolve(cwd, path)
  - 用于: write, edit, grep, find, ls

resolveReadPath(path, cwd):
  - 在 resolveToCwd 基础上
  - 如果文件不存在，尝试 macOS 变体:
    - NFD 规范化（é → e + ◌́）
    - AM/PM 变体
    - 弯引号变体
  - 用于: read（因为 LLM 可能从截图中复制带有特殊字符的文件名）
```

### 输出截断 (truncate.ts)

所有工具共享截断逻辑，防止输出过大：

```
常量:
  DEFAULT_MAX_LINES = 2000    // 最大行数
  DEFAULT_MAX_BYTES = 50KB    // 最大字节
  GREP_MAX_LINE_LENGTH = 500  // grep 每行最大字符

函数:
  truncateHead(text, options)  — 保留前 N 行，附加截断提示
  truncateTail(text)           — 保留后 N 行（bash 用）
  truncateLine(line, max)      — 截断单行
  formatSize(bytes)            — "50.0KB" 格式化
```

| 工具 | 截断方式 |
|------|----------|
| read | `truncateHead` + offset/limit 切片 |
| bash | `truncateTail`（保留尾部，因为错误通常在最后） |
| grep | `truncateLine`（每行 500 字符） + `truncateHead`（总字节） |
| find | `truncateHead`（仅字节限制） |
| ls | `truncateHead`（仅字节限制） |

### 共享渲染辅助 (render-utils.ts)

> **源码对照**: `packages/coding-agent/src/core/tools/render-utils.ts`

所有工具共享的 UI 辅助函数：

```
shortenPath(path)         — 用 ~ 缩短 home 目录前缀
str(value)                — 类型安全的字符串转换（检测非字符串参数）
replaceTabs(text)         — Tab → 空格（UI 渲染用）
normalizeDisplayText(text) — 规范化显示文本
getTextOutput(result, options) — 从 ToolResult 提取文本输出
  - 如果有图片且终端不支持显示: 返回 imageFallback + 尺寸信息
  - 使用 sanitizeBinaryOutput + stripAnsi 清理二进制和 ANSI 转义
invalidArgText()          — 样式化的 "[invalid arg]" 文本
```

### 文件变更队列 (file-mutation-queue.ts)

> **源码对照**: `packages/coding-agent/src/core/tools/file-mutation-queue.ts`

```
withFileMutationQueue<T>(filePath, fn):
  - 用 realpathSync.native 归一化路径（失败则 resolve 回退）
  - 按规范路径维护 Promise 链
  - 同一文件的写操作串行化
  - 不同文件的操作完全并行

由 edit 和 write 工具使用，解决并行工具执行时的 TOCTOU 竞态。
```

### 外部工具管理

```
ensureTool("rg", true)  — 查找或安装 ripgrep
ensureTool("fd", true)  — 查找或安装 fd
```

grep 和 find 依赖外部二进制，通过 `ensureTool` 自动管理。

---

## edit 工具深入分析

> **源码对照**: `packages/coding-agent/src/core/tools/edit.ts`, 匹配算法在 `edit-diff.ts` fuzzyFindText L79

### Schema 和参数预处理

```typescript
schema: {
  path: string,
  edits: [{ oldText: string, newText: string }]  // 多处编辑（v0.63.0+）
}
```

**向后兼容**: `prepareArguments`（`prepareEditArguments`）将旧的顶层
`{ path, oldText, newText }` 格式自动转换为 `{ path, edits: [{ oldText, newText }] }`。

### 执行流程

```
execute({ path, edits }, signal):
  1. 验证至少有一个编辑
  2. resolveToCwd(path, cwd) → absolutePath
  3. withFileMutationQueue(absolutePath, async () => {
       4. ops.readFile(absolutePath) → Buffer
       5. stripBom → { bom, text }
       6. detectLineEnding → "\r\n" | "\n"
       7. normalizeToLF(text)
       8. applyEditsToNormalizedContent(normalizedContent, edits)
          - 对每个 edit: fuzzyFindText → 唯一性检查 → 标记位置
          - 检查编辑之间无重叠
          - 按反序应用所有替换
       9. restoreLineEndings + BOM
       10. ops.writeFile(absolutePath, finalContent)
       11. generateDiffString(oldContent, newContent) → diff
       12. resolve({ content: ["Successfully replaced..."], details: { diff } })
     })
```

### 匹配策略：精确 → 模糊

```
fuzzyFindText(content, oldText):
  
  第一步: 精确匹配
    content.indexOf(oldText)
    如果找到 → 返回（usedFuzzyMatch: false）
  
  第二步: 模糊匹配（精确未找到时）
    normalizeForFuzzyMatch(content) 和 normalizeForFuzzyMatch(oldText)
    模糊规范化包括:
      - NFKC 规范化
      - 去除每行尾部空白
      - 弯引号 → 直引号（'' → '，"" → "）
      - Unicode 破折号 → ASCII 连字符
      - 特殊空格 → 普通空格
    fuzzyContent.indexOf(fuzzyOldText)
    如果找到 → 返回（usedFuzzyMatch: true, contentForReplacement 使用规范化内容）
```

**关键副作用**: 模糊匹配成功时，`contentForReplacement` 是规范化后的内容。
这意味着文件中的特殊 Unicode 字符（弯引号、破折号等）会被规范化为 ASCII。

### diff 生成 (edit-diff.ts)

使用 `diff` 包的 `Diff.diffLines` 算法：

```
generateDiffString(oldContent, newContent, contextLines=4):
  1. Diff.diffLines(old, new) → parts[]
  2. 遍历 parts:
     - 添加/删除: "+N  line" 或 "-N  line"
     - 未变化（上下文）: " N  line"（只保留变化前后 4 行）
     - 超出上下文范围: "  ..."
  3. 返回 { diff: string, firstChangedLine: number }
```

diff 只在 `details` 中返回，LLM 看到的是简短的 `"Successfully replaced text in path."` 成功消息。
`firstChangedLine` 用于 UI 导航到变化位置。

### 错误处理

| 场景 | 错误信息 |
|------|----------|
| 文件不存在/不可读 | `"File not found: ${path}"` |
| oldText 未找到（精确+模糊都失败） | `"Could not find the exact text in ${path}..."` |
| oldText 有多个匹配 | `"Found ${N} occurrences of the text in ${path}..."` |
| 替换结果与原文相同 | `"No changes made to ${path}..."` |
| abort 信号 | `"Operation aborted"` |

### 行尾处理

```
检测: 如果文件中 "\r\n" 出现在 "\n" 之前 → CRLF，否则 LF
匹配: 所有内容规范化为 LF 后再匹配
写入: 替换完成后恢复原始行尾格式
BOM: 匹配前去除，写入时恢复
```

### EditOperations 接口

```typescript
interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>
  writeFile: (absolutePath: string, content: string) => Promise<void>
  access: (absolutePath: string) => Promise<void>
}
```

默认实现使用本地 `fs`。可通过 `createEditTool(cwd, { operations })` 覆盖。

---

## bash 工具深入分析

> **源码对照**: `packages/coding-agent/src/core/tools/bash.ts` execute L182

### 执行流程

```
execute({ command, timeout }, signal, onUpdate):
  1. 解析 spawnContext（应用 spawnHook 如果存在）
  2. 前缀 commandPrefix（如 shopt -s expand_aliases）
  3. ops.exec(command, cwd, { onData, signal, timeout, env })
     └── spawn(shell, ["-c", command], { detached: true, stdio: ["ignore","pipe","pipe"] })
  4. stdout/stderr → 同一个 onData 回调
  5. handleData:
     - 累积 chunks + 跟踪 totalBytes
     - totalBytes > 50KB → 开始写临时文件
     - 保持滚动缓冲区（最近 100KB）
     - 每次 data 事件 → onUpdate（截断后的滚动缓冲区）
  6. close 事件:
     - 清理超时/监听器
     - 如果 abort → reject("aborted")
     - 如果超时 → reject("timeout:${seconds}")
     - 如果 exitCode ≠ 0 → reject（含输出文本 + 退出码）
     - 否则 → resolve({ content, details })
```

### 进程管理

```
Shell 选择 (getShellConfig):
  - 用户配置的 shellPath
  - Git Bash (Windows)
  - /bin/bash (Unix)
  - 回退到 sh

进程组:
  spawn({ detached: true })  — 子进程成为进程组 leader

终止 (killProcessTree):
  - Unix: process.kill(-pid, "SIGKILL")  — 杀死整个进程组
  - Windows: taskkill /F /T /PID          — 杀死进程树
  - 回退: process.kill(pid, "SIGKILL")
```

### 超时

```
schema: timeout: Type.Optional(Type.Number)  — 秒为单位，可选
默认: 无超时（运行直到完成或 abort）
实现: setTimeout → killProcessTree → timedOut = true
```

### 环境变量

```
getShellEnv():
  - 继承 process.env
  - 确保 pi 的工具目录（fd, rg 等）在 PATH 中
  - spawnHook 可以完全替换 env
```

### 输出格式

```
正常退出 (exitCode === 0):
  content: [{ type: "text", text: output }]
  details: { truncation?, fullOutputPath? }

非零退出:
  reject(new Error(output + "\n\nCommand exited with code ${exitCode}"))

截断时追加:
  "[Showing lines ${start}-${end} of ${total}. Full output: ${tempPath}]"
```

### BashOperations 接口

```typescript
interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void
      signal?: AbortSignal
      timeout?: number
      env?: NodeJS.ProcessEnv
    }
  ) => Promise<{ exitCode: number | null }>
}
```

---

## read 工具

> **源码对照**: `packages/coding-agent/src/core/tools/read.ts` execute L58

### 特殊能力

read 是唯一能处理图片的工具：

```
如果 detectImageMimeType(absolutePath) 返回 mime 类型:
  1. readFile → Buffer
  2. resizeImage(buffer, 2000, 2000)  — 缩放到 2000x2000 以内
  3. 返回:
     content: [
       { type: "text", text: "Read image file [mimeType]\n<dimension note>" },
       { type: "image", data: base64, mimeType }
     ]
```

### 行切片

```
offset + limit 应用:
  - offset=1 表示从第一行开始（1-indexed）
  - 先切片，再截断
  - 截断提示: "[Showing lines 1-2000 of 5432. Use offset=2001 to continue.]"
```

### 特大行处理

如果第一行超过 50KB:
```
"[Line 1 is 35KB, exceeds 50KB limit. Use bash: sed -n '1p' path | head -c 51200]"
```

### ReadOperations 接口

```typescript
interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>
  access: (absolutePath: string) => Promise<void>
  detectImageMimeType?: (absolutePath: string) => string | undefined
}
```

---

## write 工具

> **源码对照**: `packages/coding-agent/src/core/tools/write.ts` execute L44

### 执行流程

```
execute({ path, content }, signal):
  1. resolveToCwd(path, cwd) → absolutePath
  2. withFileMutationQueue(absolutePath, async () => {
       3. ops.mkdir(dirname(absolutePath))  — 创建父目录
       4. ops.writeFile(absolutePath, content)
     })
  5. resolve({ content: ["Successfully wrote ${bytes} bytes to ${path}"] })
```

### WriteOperations 接口

```typescript
interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
}
```

**注意**: write 通过 `withFileMutationQueue` 与 edit 共享文件级串行化。

---

## grep 工具

> **源码对照**: `packages/coding-agent/src/core/tools/grep.ts` execute L71

### 执行流程

```
execute({ pattern, path, glob, ignoreCase, literal, context, limit }):
  1. ensureTool("rg", true)  — 确保 ripgrep 可用
  2. 构建 rg 参数:
     rg --json --line-number --color=never --hidden
     --ignore-case (如果 ignoreCase)
     --fixed-strings (如果 literal)
     --glob (如果有 glob)
     --context-separator="" (如果有 context)
     -C ${context} (如果有 context)
  3. spawn rg 进程
  4. 解析 JSON 行输出
  5. 收集匹配直到 limit（默认 100）
  6. 达到限制 → 杀死 rg 进程
  7. 每个匹配: truncateLine（500 字符）
  8. 按文件分组，带上下文行
  9. truncateHead（总字节限制）
  10. 返回格式化文本
```

### 输出格式

```
pattern 在 file1.ts 中:
  L12: matched line content
  L13: context line
  
pattern 在 file2.ts 中:
  L45: another match

[Found 15 matches in 3 files. Showing first 100.]
```

---

## find 工具

> **源码对照**: `packages/coding-agent/src/core/tools/find.ts` execute L64

### 执行流程

```
execute({ pattern, path, limit }):
  1. 如果有自定义 ops.glob → 使用它
  2. 否则: ensureTool("fd", true)
  3. 构建 fd 参数:
     fd --glob --hidden --no-ignore-parent
     --ignore-file .gitignore (收集所有 .gitignore)
  4. spawnSync 执行
  5. 相对化路径 + POSIX 格式
  6. 限制结果数量（默认 1000）
  7. truncateHead（字节限制）
  8. 返回文件列表
```

---

## ls 工具

> **源码对照**: `packages/coding-agent/src/core/tools/ls.ts` execute L54

### 执行流程

```
execute({ path, limit }):
  1. resolveToCwd(path || ".", cwd)
  2. ops.readdir(dirPath)
  3. 字母排序
  4. 对每个条目: ops.stat → 目录加 "/" 后缀
  5. 限制条目数（默认 500）
  6. truncateHead（字节限制）
  7. 返回条目列表
```

---

## 可插拔操作模式总结

```
┌──────────┐     ┌──────────────────┐     ┌───────────────┐
│  工具    │     │  Operations 接口  │     │  默认实现      │
│  逻辑    │ ──→ │  readFile()      │ ──→ │  本地 fs       │
│          │     │  writeFile()     │     │               │
│          │     │  access()        │     └───────────────┘
│          │     │  exec()          │
│          │     │  readdir()       │     ┌───────────────┐
│          │     │  stat()          │ ──→ │  SSH 远程      │
│          │     │  ...             │     │  (扩展提供)    │
└──────────┘     └──────────────────┘     └───────────────┘
                                          ┌───────────────┐
                                     ──→  │  Mock          │
                                          │  (测试用)      │
                                          └───────────────┘
```

每个工具:
1. 定义一个 `XxxOperations` 接口
2. 提供 `defaultXxxOperations`（使用 Node.js `fs`）
3. 通过 `options?.operations` 允许覆盖

这样工具逻辑和 I/O 完全分离，支持远程执行和单元测试。

## 新增基础设施模块

| 模块 | 职责 |
|------|------|
| `file-mutation-queue.ts` | 按规范文件路径串行化写操作，edit/write 共享 |
| `render-utils.ts` | 共享 UI 渲染辅助（路径缩短、文本输出、图片占位） |
| `tool-definition-wrapper.ts` | `wrapToolDefinition` — ToolDefinition → AgentTool 转换，注入 ExtensionContext |
