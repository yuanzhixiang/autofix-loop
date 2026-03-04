import { readFile, rm, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const defaultRepoDir = join(root, "sandbox", "target-repo");
const defaultTasksFile = join(root, "tasks", "tasks.jsonl");
const workerScript = new URL("./worker.mjs", import.meta.url).pathname;
const gateScript = new URL("./gate.mjs", import.meta.url).pathname;

const repoDir = resolve(process.env.PIPELINE_TARGET_REPO || defaultRepoDir);
const tasksFile = resolve(process.env.PIPELINE_TASKS_FILE || defaultTasksFile);
const worktreesRoot = resolve(process.env.PIPELINE_WORKTREES_ROOT || join(root, "sandbox", "worktrees"));
const baseBranch = process.env.PIPELINE_BASE_BRANCH || "main";
const defaultExecutor = process.env.PIPELINE_EXECUTOR || "codex";

function run(cmd, args, cwd, { capture = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolveResult({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} failed (code ${code})${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}

function splitLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readTasks(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function ensurePathExists(path, label) {
  try {
    await stat(path);
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

async function ensureCodexAvailableIfNeeded(tasks) {
  const requiresCodex = tasks.some((task) => (task.executor || defaultExecutor) === "codex");
  if (!requiresCodex) {
    return;
  }

  await run("codex", ["--version"], repoDir, { capture: true });
}

async function checkoutTaskWorktree(task) {
  const branch = `agent/${task.id.toLowerCase()}`;
  const dir = join(worktreesRoot, task.id.toLowerCase());

  await run("git", ["checkout", baseBranch], repoDir, { capture: true });
  await rm(dir, { recursive: true, force: true });

  try {
    await run("git", ["branch", "-D", branch], repoDir, { capture: true });
  } catch {
    // branch may not exist
  }

  await run("git", ["worktree", "add", dir, "-b", branch, baseBranch], repoDir);
  return { dir, branch };
}

async function runWorker(task, worktreeDir) {
  return new Promise((resolveResult) => {
    const child = spawn("node", [workerScript, worktreeDir, JSON.stringify(task)], {
      cwd: worktreeDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PIPELINE_DEFAULT_EXECUTOR: defaultExecutor
      }
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", () => {
      const lastLine = splitLines(stdout).at(-1);

      if (!lastLine) {
        resolveResult({ id: task.id, ok: false, error: `No worker output. stderr: ${stderr}` });
        return;
      }

      try {
        const parsed = JSON.parse(lastLine);
        resolveResult(parsed);
      } catch {
        resolveResult({ id: task.id, ok: false, error: `Invalid worker output: ${lastLine}\n${stderr}` });
      }
    });
  });
}

async function checkoutIntegrationBranch() {
  const integrationBranch = `auto/integration-${Date.now()}`;

  await run("git", ["checkout", baseBranch], repoDir, { capture: true });
  try {
    await run("git", ["branch", "-D", integrationBranch], repoDir, { capture: true });
  } catch {
    // branch may not exist
  }

  await run("git", ["checkout", "-b", integrationBranch, baseBranch], repoDir);
  return integrationBranch;
}

async function integrate(results, taskWorktreeMap) {
  const successful = results.filter((item) => item.ok);
  if (successful.length === 0) {
    return null;
  }

  const integrationBranch = await checkoutIntegrationBranch();

  for (const result of successful) {
    const taskWorktree = taskWorktreeMap.get(result.id);
    await run("git", ["cherry-pick", result.commit], repoDir);
    const { stdout } = await run("git", ["show", "--name-only", "--pretty=format:%s", "HEAD"], repoDir, { capture: true });
    console.log(`Integrated ${result.id}: ${stdout.trim().split(/\r?\n/)[0]} (${taskWorktree.dir})`);
  }

  await run("node", [gateScript, repoDir], repoDir);
  return integrationBranch;
}

async function cleanup(taskWorktreeMap) {
  for (const { dir, branch } of taskWorktreeMap.values()) {
    try {
      await run("git", ["worktree", "remove", dir, "--force"], repoDir, { capture: true });
    } catch {
      // ignore cleanup failure
    }
    try {
      await run("git", ["branch", "-D", branch], repoDir, { capture: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

async function main() {
  await ensurePathExists(repoDir, "Target repo");
  await ensurePathExists(tasksFile, "Tasks file");

  const rawTasks = await readFile(tasksFile, "utf8");
  const tasks = readTasks(rawTasks);

  if (tasks.length === 0) {
    throw new Error("No tasks loaded from tasks file");
  }

  await ensureCodexAvailableIfNeeded(tasks);
  await mkdir(worktreesRoot, { recursive: true });

  const taskWorktreeMap = new Map();
  const keepWorktrees = process.env.PIPELINE_KEEP_WORKTREES === "1";

  console.log(`Target repo: ${repoDir}`);
  console.log(`Base branch: ${baseBranch}`);
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Default executor: ${defaultExecutor}`);

  for (const task of tasks) {
    const worktree = await checkoutTaskWorktree(task);
    taskWorktreeMap.set(task.id, worktree);
  }

  const concurrency = Math.max(1, Number(process.env.PIPELINE_CONCURRENCY || "2"));
  const queue = [...tasks];
  const results = [];

  async function workerLoop() {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) return;

      const { dir } = taskWorktreeMap.get(task.id);
      console.log(`Start ${task.id}: ${task.title}`);
      const result = await runWorker(task, dir);
      results.push(result);
      console.log(`Done ${task.id}: ${result.ok ? "ok" : "failed"}`);
    }
  }

  let integrationBranch = null;
  try {
    await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
    integrationBranch = await integrate(results, taskWorktreeMap);
  } finally {
    if (!keepWorktrees) {
      await cleanup(taskWorktreeMap);
    }
  }

  const okCount = results.filter((item) => item.ok).length;
  const failCount = results.length - okCount;

  console.log("\nSummary");
  for (const item of results) {
    if (item.ok) {
      const changed = Array.isArray(item.changedFiles) ? item.changedFiles.join(", ") : "";
      console.log(`- ${item.id}: OK (${item.commit}) attempt=${item.attempt}${changed ? ` files=[${changed}]` : ""}`);
    } else {
      console.log(`- ${item.id}: FAIL (${item.error})`);
    }
  }

  console.log(`\nSucceeded: ${okCount}, Failed: ${failCount}`);
  if (integrationBranch) {
    console.log(`Integrated branch: ${integrationBranch}`);
    console.log(`Inspect: cd ${repoDir} && git log --oneline --decorate --graph --max-count=12`);
  } else {
    console.log("No successful tasks, so no integration branch was created.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
