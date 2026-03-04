#!/usr/bin/env node

import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatcherScript = path.join(toolRoot, "pipeline", "dispatcher.mjs");

const ACTION_HINTS = [
  "修复",
  "fix",
  "解决",
  "处理",
  "改",
  "重构",
  "优化",
  "实现",
  "添加",
  "删除",
  "更新"
];

const QUESTION_HINTS = ["什么", "为什么", "问题", "状态", "如何", "怎么", "评估", "诊断", "分析", "有没有"];

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

Modes:
  - 问句/分析类输入 => 只做诊断并输出文字回答
  - 修复类输入       => 执行自动修复流水线

Chat commands:
  /ask <question>   只诊断，不改代码
  /run <task>       执行修复流水线
  /help             显示帮助
  /exit             退出

Options:
  --base <branch>         Base branch for worktrees (default: current branch)
  --concurrency <n>       Worker concurrency (default: 1)
  --attempts <n>          Max attempts per task (default: 2)
  --executor <name>       Task executor: codex|replace (default: codex)
  -h, --help              Show this help

Examples:
  autofix-loop "这个项目现在有什么问题？"
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

function normalizeText(text) {
  return text.trim().toLowerCase();
}

function classifyPrompt(rawInput) {
  const input = rawInput.trim();
  const normalized = normalizeText(input);

  if (normalized === "/help") {
    return { type: "help" };
  }
  if (normalized === "/exit" || normalized === "exit" || normalized === "quit") {
    return { type: "exit" };
  }
  if (normalized.startsWith("/ask ")) {
    return { type: "ask", prompt: input.slice(5).trim() };
  }
  if (normalized.startsWith("/run ")) {
    return { type: "run", prompt: input.slice(5).trim() };
  }

  if (/[?？]$/.test(input) || QUESTION_HINTS.some((hint) => input.includes(hint))) {
    const hasActionHint = ACTION_HINTS.some((hint) => normalized.includes(hint));
    if (!hasActionHint) {
      return { type: "ask", prompt: input };
    }
  }

  if (ACTION_HINTS.some((hint) => normalized.includes(hint))) {
    return { type: "run", prompt: input };
  }

  return { type: "ask", prompt: input };
}

async function detectCurrentBranch(repoDir) {
  const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoDir, { capture: true });
  return stdout.trim();
}

async function ensureGitRepo(repoDir) {
  await run("git", ["rev-parse", "--is-inside-work-tree"], repoDir, { capture: true });
}

function buildFixPrompt(userPrompt) {
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

function buildAskPrompt(userPrompt) {
  return `You are a senior software engineer assistant inside a local repository.

User question: ${userPrompt}

Please inspect the current repository in read-only mode and provide a concise Chinese answer.
Required workflow:
1) Check git status briefly.
2) If package.json has scripts.test/scripts.check, run them and summarize pass/fail.
3) Identify concrete current problems (if any).
4) Give the next action in 1-3 steps.

Constraints:
- Do not modify any file.
- Do not run git commit/push.
- Reply in Chinese.`;
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
    prompt: buildFixPrompt(prompt),
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

async function askWithCodex({ repoDir, question }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "autofix-loop-ask-"));
  const outputFile = path.join(tempDir, "answer.txt");

  try {
    await run(
      "codex",
      [
        "exec",
        "--ephemeral",
        "-C",
        repoDir,
        "--sandbox",
        "read-only",
        "-o",
        outputFile,
        buildAskPrompt(question)
      ],
      repoDir,
      { capture: true }
    );

    const answer = (await readFile(outputFile, "utf8")).trim();
    if (!answer) {
      console.log("未获取到文本回答。你可以换个问法，或者直接用 /run 发起修复。\n");
      return;
    }

    console.log(`\n${answer}\n`);
  } catch (error) {
    console.error(`诊断失败: ${error.message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function summarizePostRun({ repoDir, baseBranch }) {
  const branch = await detectCurrentBranch(repoDir);
  if (!branch.startsWith("auto/integration-")) {
    console.log("\n本轮没有产生修复提交（通常表示当前仓库已健康）。\n");
    return;
  }

  const { stdout } = await run("git", ["log", "--oneline", `${baseBranch}..${branch}`], repoDir, { capture: true });
  const commits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  console.log(`\n本轮已产出修复分支: ${branch}`);
  if (commits.length > 0) {
    console.log("修复提交:");
    for (const line of commits) {
      console.log(`- ${line}`);
    }
  }
  console.log("");
}

async function handlePrompt({ repoDir, baseBranch, concurrency, attempts, executor, rawInput }) {
  const decision = classifyPrompt(rawInput);

  if (decision.type === "help") {
    printHelp();
    return { exit: false };
  }

  if (decision.type === "exit") {
    return { exit: true };
  }

  if (!decision.prompt) {
    console.log("请输入有效内容，或使用 /help 查看帮助。\n");
    return { exit: false };
  }

  if (decision.type === "ask") {
    await askWithCodex({ repoDir, question: decision.prompt });
    return { exit: false };
  }

  await runPromptTask({
    repoDir,
    baseBranch,
    concurrency,
    attempts,
    executor,
    prompt: decision.prompt
  });
  await summarizePostRun({ repoDir, baseBranch });
  return { exit: false };
}

async function runChatMode({ repoDir, baseBranch, concurrency, attempts, executor }) {
  console.log("autofix-loop chat mode");
  console.log(`target repo: ${repoDir}`);
  console.log(`base branch: ${baseBranch}`);
  console.log("/ask 提问诊断，/run 发起修复，/help 查看帮助，/exit 退出\n");

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

      try {
        const { exit } = await handlePrompt({
          repoDir,
          baseBranch,
          concurrency,
          attempts,
          executor,
          rawInput: line
        });
        if (exit) {
          break;
        }
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

  await handlePrompt({
    repoDir,
    baseBranch,
    concurrency,
    attempts,
    executor,
    rawInput: prompt
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
