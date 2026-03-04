# AI Pipeline Minimum Demo

这是一个最小可跑的“AI 自动修复流水线”演示：

- `dispatcher`：读取任务、分发并行 worker、集成提交。
- `worker`：在独立 worktree 修复一个任务并提交。
- `gate`：执行门禁（`pnpm test` + `pnpm check`）。

## 目录

- `pipeline/init-demo-repo.mjs`：初始化一个带 bug 的目标仓库。
- `pipeline/dispatcher.mjs`：并行调度 + 集成。
- `pipeline/worker.mjs`：单任务执行器。
- `pipeline/gate.mjs`：统一 gate。
- `tasks/tasks.jsonl`：任务队列。
- `sandbox/target-repo`：运行时目标仓库。

## 快速开始

```bash
pnpm install
pnpm run init
pnpm run run
```

## 你会看到什么

1. 初始化一个有 3 个 bug 的 git 仓库。
2. 3 个任务并行修复，每个任务在独立 branch/worktree。
3. 每个任务通过 gate 才 commit。
4. dispatcher 把成功提交 cherry-pick 到 `auto/integration-<timestamp>`。
5. 最后在集成分支跑一次总 gate。

## 调整并发

```bash
PIPELINE_CONCURRENCY=3 pnpm run run
```
