# Autofix Loop

Autofix Loop 是一个可迭代的“自修复流水线”项目：

- `dispatcher`：读取任务、创建独立 worktree、并行分发 worker、集成提交。
- `worker`：执行单任务（支持真实 `codex exec`）、跑门禁、自动提交。
- `gate`：统一门禁（`pnpm test` + `pnpm check`）。

## 核心能力

- 使用本地 `codex` 做真实代码修改（非 mock）。
- 每个任务独立分支，降低冲突和回滚成本。
- 任务级 gate，失败自动重试（默认 2 次）。
- 可限制任务只允许修改指定文件（`allowedFiles`）。
- 成功任务自动 cherry-pick 到集成分支 `auto/integration-*`。

## 目录

- `pipeline/init-demo-repo.mjs`：初始化一个带 bug 的 demo 目标仓库。
- `pipeline/dispatcher.mjs`：并行调度 + 集成。
- `pipeline/worker.mjs`：单任务执行器（`codex` / `replace`）。
- `pipeline/gate.mjs`：统一 gate。
- `tasks/tasks.jsonl`：任务队列。
- `sandbox/target-repo`：demo 目标仓库。

## 前置要求

1. Node.js 22+
2. pnpm
3. 本地可用的 `codex` CLI（并完成登录）

快速检查：

```bash
codex --version
```

## 像 Codex 一样直接聊天

先在工具仓安装全局命令（一次即可）：

```bash
cd /Users/yuanzhixiang/workspace/project/autofix-loop/autofix-loop
pnpm link --global
```

然后你在任意目标仓目录下都可以直接用：

```bash
autofix-loop "修复 pnpm test 和 pnpm check 失败"
```

或者进入连续对话模式：

```bash
autofix-loop chat
```

说明：

- 命令会自动把“当前目录”当成目标仓库。
- 默认在当前分支上起修复工作流（可用 `--base` 覆盖）。
- 如果当前仓库已经健康，会输出 `skipped, no changes needed`，不会硬提交空改动。

## 快速开始（Demo）

```bash
pnpm install
pnpm run init
pnpm run run
```

你会看到：

1. 初始化一个有 bug 的 demo 仓库。
2. Codex 在独立 worktree 中执行每个修复任务。
3. 每个任务通过 gate 后自动 commit。
4. dispatcher 将成功任务集成到 `auto/integration-*`。
5. 在集成分支再跑一次总 gate。

## 在真实仓库使用

1. 准备任务文件（JSONL，每行一个任务）。
2. 指向目标仓库和任务文件运行 dispatcher。

```bash
PIPELINE_TARGET_REPO=/absolute/path/to/your-repo \
PIPELINE_TASKS_FILE=/absolute/path/to/tasks.jsonl \
PIPELINE_BASE_BRANCH=main \
pnpm run run
```

如果你不想每次写 `PIPELINE_TASKS_FILE`，优先用上面的 `autofix-loop "<prompt>"` 或 `autofix-loop chat`。

## 任务格式（JSONL）

```json
{
  "id": "T1",
  "title": "Fix add() math bug",
  "executor": "codex",
  "prompt": "Fix src/math.js so add(a, b) returns the arithmetic sum.",
  "allowedFiles": ["src/math.js"],
  "gateTest": "test/add.test.js",
  "commitMessage": "fix(math): correct add implementation"
}
```

字段说明：

- `id`：任务 ID（唯一）。
- `title`：任务标题。
- `executor`：`codex` 或 `replace`（不填时走 `PIPELINE_EXECUTOR`，默认 `codex`）。
- `prompt`：给 Codex 的任务描述（`codex` 必填）。
- `allowedFiles`：允许修改的文件/目录（目录用 `path/` 结尾）。
- `gateTest`：任务级测试目标（如 `test/foo.test.js`）。
- `commitMessage`：成功后提交信息。
- `find` / `replace` / `targetFile`：仅 `replace` 执行器使用。

## 常用环境变量

- `PIPELINE_TARGET_REPO`：目标仓库路径。
- `PIPELINE_TASKS_FILE`：任务文件路径。
- `PIPELINE_BASE_BRANCH`：基准分支（默认 `main`）。
- `PIPELINE_CONCURRENCY`：并发 worker 数（默认 `2`）。
- `PIPELINE_MAX_ATTEMPTS`：单任务最大尝试次数（默认 `2`）。
- `PIPELINE_EXECUTOR`：默认执行器（默认 `codex`）。
- `PIPELINE_KEEP_WORKTREES=1`：保留 worktree 便于排错。

## 重置 Demo

```bash
pnpm run reset
```
