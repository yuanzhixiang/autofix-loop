#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatcherScript = path.join(toolRoot, "pipeline", "dispatcher.mjs");

function parseArgs(argv) {
  const options = {
    baseBranch: "",
    concurrency: "1",
    attempts: "2",
    executor: "codex"
  };

  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--base") {
      options.baseBranch = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--concurrency") {
      options.concurrency = argv[index + 1] || "1";
      index += 1;
      continue;
    }
    if (token === "--attempts") {
      options.attempts = argv[index + 1] || "2";
      index += 1;
      continue;
    }
    if (token === "--executor") {
      options.executor = argv[index + 1] || "codex";
      index += 1;
      continue;
    }
    positional.push(token);
  }

  return { options, positional };
}

function printHelp() {
  console.log(`Autofix Loop CLI

Usage:
  autofix-loop "<prompt>"
  autofix-loop chat

Options:
  --base <branch>         Base branch for worktrees (default: current branch)
  --concurrency <n>       Worker concurrency (default: 1)
  --attempts <n>          Max attempts per task (default: 2)
  --executor <name>       Task executor: codex|replace (default: codex)
  -h, --help              Show this help

Examples:
  autofix-loop "修复 pnpm test 和 pnpm check 失败"
  autofix-loop chat
`);
}

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

async function detectCurrentBranch(repoDir) {
  const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoDir, { capture: true });
  return stdout.trim();
}

async function ensureGitRepo(repoDir) {
  await run("git", ["rev-parse", "--is-inside-work-tree"], repoDir, { capture: true });
}

function buildPrompt(userPrompt) {
  return `${userPrompt}

Run \`pnpm test\` and \`pnpm check\`. If either fails, fix root causes with minimal safe changes until both pass.
If both already pass, make no code changes and stop.
Do not disable checks, do not add unrelated changes, do not push.`;
}

function buildCommitMessage(userPrompt) {
  const trimmed = userPrompt.replace(/\s+/g, " ").trim();
  const short = trimmed.slice(0, 56);
  return short ? `fix: ${short}` : "fix: autofix-loop chat task";
}

async function runDispatcherWithEnv({ repoDir, taskFile, baseBranch, concurrency, attempts, executor }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [dispatcherScript], {
      cwd: toolRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PIPELINE_TARGET_REPO: repoDir,
        PIPELINE_TASKS_FILE: taskFile,
        PIPELINE_BASE_BRANCH: baseBranch,
        PIPELINE_CONCURRENCY: String(concurrency),
        PIPELINE_MAX_ATTEMPTS: String(attempts),
        PIPELINE_EXECUTOR: executor
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`dispatcher failed with code ${code}`));
      }
    });
  });
}

async function runPromptTask({ repoDir, baseBranch, concurrency, attempts, executor, prompt }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "autofix-loop-"));
  const taskFile = path.join(tempDir, "task.jsonl");
  const taskId = `CHAT${Date.now().toString(36).toUpperCase()}`;

  const task = {
    id: taskId,
    title: "Chat-driven self-heal task",
    executor,
    prompt: buildPrompt(prompt),
    commitMessage: buildCommitMessage(prompt)
  };

  try {
    await writeFile(taskFile, `${JSON.stringify(task)}\n`, "utf8");
    await runDispatcherWithEnv({
      repoDir,
      taskFile,
      baseBranch,
      concurrency,
      attempts,
      executor
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runChatMode({ repoDir, baseBranch, concurrency, attempts, executor }) {
  console.log(`autofix-loop chat mode`);
  console.log(`target repo: ${repoDir}`);
  console.log(`base branch: ${baseBranch}`);
  console.log(`type /exit to quit\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    while (true) {
      const line = (await rl.question("autofix-loop> ")).trim();
      if (!line) {
        continue;
      }
      if (line === "/exit" || line === "exit" || line === "quit") {
        break;
      }

      try {
        await runPromptTask({
          repoDir,
          baseBranch,
          concurrency,
          attempts,
          executor,
          prompt: line
        });
      } catch (error) {
        console.error(`run failed: ${error.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const repoDir = process.cwd();
  await ensureGitRepo(repoDir);

  const baseBranch = options.baseBranch || (await detectCurrentBranch(repoDir));
  const concurrency = Number(options.concurrency || "1");
  const attempts = Number(options.attempts || "2");
  const executor = options.executor || "codex";

  if (executor === "codex") {
    await run("codex", ["--version"], repoDir, { capture: true });
  }

  if (positional[0] === "chat") {
    await runChatMode({ repoDir, baseBranch, concurrency, attempts, executor });
    return;
  }

  const prompt = positional.join(" ").trim();
  if (!prompt) {
    printHelp();
    process.exit(2);
  }

  await runPromptTask({
    repoDir,
    baseBranch,
    concurrency,
    attempts,
    executor,
    prompt
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
