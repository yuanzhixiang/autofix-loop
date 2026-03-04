import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const repoDir = join(root, "sandbox", "target-repo");
const worktreesRoot = join(root, "sandbox", "worktrees");
const tasksFile = join(root, "tasks", "tasks.jsonl");
const workerScript = new URL("./worker.mjs", import.meta.url).pathname;
const gateScript = new URL("./gate.mjs", import.meta.url).pathname;

function run(cmd, args, cwd, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
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
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} failed (code ${code})${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}

function readTasks(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function checkoutTaskWorktree(task) {
  const branch = `agent/${task.id.toLowerCase()}`;
  const dir = join(worktreesRoot, task.id.toLowerCase());

  await run("git", ["checkout", "main"], repoDir, { capture: true });
  await rm(dir, { recursive: true, force: true });
  try {
    await run("git", ["branch", "-D", branch], repoDir, { capture: true });
  } catch {
    // branch may not exist
  }

  await run("git", ["worktree", "add", dir, "-b", branch, "main"], repoDir);
  return { dir, branch };
}

async function runWorker(task, worktreeDir) {
  return new Promise((resolve) => {
    const child = spawn("node", [workerScript, worktreeDir, JSON.stringify(task)], {
      cwd: worktreeDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      const lastLine = stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .at(-1);

      if (!lastLine) {
        resolve({ id: task.id, ok: false, error: `No worker output. stderr: ${stderr}` });
        return;
      }

      try {
        const parsed = JSON.parse(lastLine);
        resolve(parsed);
      } catch {
        resolve({ id: task.id, ok: false, error: `Invalid worker output: ${lastLine}\n${stderr}` });
      }

      if (code !== 0) {
        // keep parsed payload as source of truth
      }
    });
  });
}

async function integrate(results, taskWorktreeMap) {
  const integrationBranch = `auto/integration-${Date.now()}`;

  await run("git", ["checkout", "main"], repoDir, { capture: true });
  try {
    await run("git", ["branch", "-D", integrationBranch], repoDir, { capture: true });
  } catch {
    // branch may not exist
  }

  await run("git", ["checkout", "-b", integrationBranch, "main"], repoDir);

  for (const result of results) {
    if (!result.ok) continue;
    const { dir } = taskWorktreeMap.get(result.id);
    await run("git", ["cherry-pick", result.commit], repoDir);
    const { stdout } = await run("git", ["show", "--name-only", "--pretty=format:%s", "HEAD"], repoDir, { capture: true });
    console.log(`Integrated ${result.id}: ${stdout.trim().split(/\r?\n/)[0]} (${dir})`);
  }

  await run("node", [gateScript, repoDir], repoDir);
  return integrationBranch;
}

async function cleanup(taskWorktreeMap) {
  for (const { dir, branch } of taskWorktreeMap.values()) {
    try {
      await run("git", ["worktree", "remove", dir, "--force"], repoDir, { capture: true });
    } catch {
      // ignore
    }
    try {
      await run("git", ["branch", "-D", branch], repoDir, { capture: true });
    } catch {
      // ignore
    }
  }
}

async function main() {
  const rawTasks = await readFile(tasksFile, "utf8");
  const tasks = readTasks(rawTasks);

  await mkdir(worktreesRoot, { recursive: true });
  const taskWorktreeMap = new Map();

  console.log(`Loaded ${tasks.length} tasks`);

  for (const task of tasks) {
    const worktree = await checkoutTaskWorktree(task);
    taskWorktreeMap.set(task.id, worktree);
  }

  const concurrency = Number(process.env.PIPELINE_CONCURRENCY || "2");
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

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => workerLoop()));

  const integrationBranch = await integrate(results, taskWorktreeMap);

  await cleanup(taskWorktreeMap);

  const okCount = results.filter((item) => item.ok).length;
  const failCount = results.length - okCount;

  console.log("\nSummary");
  for (const item of results) {
    if (item.ok) {
      console.log(`- ${item.id}: OK (${item.commit})`);
    } else {
      console.log(`- ${item.id}: FAIL (${item.error})`);
    }
  }

  console.log(`\nIntegrated branch: ${integrationBranch}`);
  console.log(`Succeeded: ${okCount}, Failed: ${failCount}`);
  console.log(`Inspect: cd ${repoDir} && git log --oneline --decorate --graph --max-count=12`);
}

main().catch(async (error) => {
  console.error(error.message);
  process.exit(1);
});
