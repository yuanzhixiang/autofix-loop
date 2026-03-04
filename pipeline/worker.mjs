import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

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

function splitLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedFileAllowed(path, allowedFiles) {
  return allowedFiles.some((allowed) => {
    if (allowed.endsWith("/")) {
      return path.startsWith(allowed);
    }
    return path === allowed;
  });
}

async function listChangedFiles(repoDir) {
  const tracked = await run("git", ["diff", "--name-only"], repoDir, { capture: true });
  const untracked = await run("git", ["ls-files", "--others", "--exclude-standard"], repoDir, { capture: true });

  const files = [...splitLines(tracked.stdout), ...splitLines(untracked.stdout)];
  return Array.from(new Set(files));
}

async function applyReplaceTask(repoDir, task) {
  const filePath = join(repoDir, task.targetFile);
  const original = await readFile(filePath, "utf8");

  if (!task.find || !task.replace) {
    throw new Error("replace executor requires task.find and task.replace");
  }

  if (!original.includes(task.find)) {
    throw new Error(`Pattern not found in ${task.targetFile}`);
  }

  const updated = original.replace(task.find, task.replace);
  await writeFile(filePath, updated, "utf8");
}

function buildCodexPrompt(task, attempt, previousError) {
  const lines = [
    `Task ID: ${task.id}`,
    `Task title: ${task.title}`,
    "",
    "Goal:",
    task.prompt || task.title,
    "",
    "Requirements:",
    "- Make the minimal code edits needed to complete the goal.",
    "- Do not run git commit or git push.",
    "- Keep the codebase buildable and testable."
  ];

  if (Array.isArray(task.allowedFiles) && task.allowedFiles.length > 0) {
    lines.push(`- Only edit these files/paths: ${task.allowedFiles.join(", ")}.`);
  }

  if (task.gateTest) {
    lines.push(`- The verification target is: ${task.gateTest}.`);
  }

  if (attempt > 1 && previousError) {
    lines.push("", `Previous attempt failed with: ${previousError}`);
    lines.push("Address that failure in this attempt.");
  }

  lines.push("", "After editing files, stop.");
  return lines.join("\n");
}

async function applyCodexTask(repoDir, task, attempt, previousError) {
  const prompt = buildCodexPrompt(task, attempt, previousError);
  await run("codex", ["exec", "--ephemeral", "-C", repoDir, prompt], repoDir);
}

async function runTaskExecutor(repoDir, task, executor, attempt, previousError) {
  if (executor === "replace") {
    await applyReplaceTask(repoDir, task);
    return;
  }

  if (executor === "codex") {
    await applyCodexTask(repoDir, task, attempt, previousError);
    return;
  }

  throw new Error(`Unknown executor: ${executor}`);
}

async function runGate(repoDir, task) {
  const gateArgs = task.gateTest ? [gateScript, repoDir, task.gateTest] : [gateScript, repoDir];
  await run("node", gateArgs, repoDir);
}

async function commitChanges(repoDir, task, changedFiles) {
  await run("git", ["add", "-A", "--", ...changedFiles], repoDir);

  const commitMessage = task.commitMessage || `fix(${task.id.toLowerCase()}): ${task.title}`;
  await run("git", ["commit", "-m", commitMessage], repoDir);

  const { stdout } = await run("git", ["rev-parse", "HEAD"], repoDir, { capture: true });
  return stdout.trim();
}

async function attemptTask(repoDir, task, executor, attempt, previousError) {
  await run("git", ["reset", "--hard", "HEAD"], repoDir);
  await run("git", ["clean", "-fd"], repoDir);

  await runTaskExecutor(repoDir, task, executor, attempt, previousError);

  const changedFiles = await listChangedFiles(repoDir);
  if (changedFiles.length === 0) {
    await runGate(repoDir, task);
    return { commit: null, changedFiles: [], skipped: true };
  }

  if (Array.isArray(task.allowedFiles) && task.allowedFiles.length > 0) {
    const illegal = changedFiles.filter((file) => !changedFileAllowed(file, task.allowedFiles));
    if (illegal.length > 0) {
      throw new Error(`Task modified files outside allowlist: ${illegal.join(", ")}`);
    }
  }

  await runGate(repoDir, task);

  const commit = await commitChanges(repoDir, task, changedFiles);
  return { commit, changedFiles, skipped: false };
}

async function main() {
  const repoDir = process.argv[2];
  const taskRaw = process.argv[3];

  if (!repoDir || !taskRaw) {
    console.error("Usage: node pipeline/worker.mjs <repoDir> '<task-json>'");
    process.exit(2);
  }

  const task = JSON.parse(taskRaw);
  const executor = task.executor || process.env.PIPELINE_DEFAULT_EXECUTOR || "codex";
  const maxAttempts = Math.max(1, Number(process.env.PIPELINE_MAX_ATTEMPTS || "2"));

  let previousError = "";

  try {
    await run("pnpm", ["install", "--silent"], repoDir);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const { commit, changedFiles, skipped } = await attemptTask(repoDir, task, executor, attempt, previousError);
        const result = {
          id: task.id,
          ok: true,
          executor,
          attempt,
          commit,
          skipped,
          changedFiles
        };
        console.log(JSON.stringify(result));
        return;
      } catch (error) {
        previousError = error.message;
        if (attempt === maxAttempts) {
          throw error;
        }
      }
    }
  } catch (error) {
    const result = {
      id: task.id,
      ok: false,
      executor,
      attempts: maxAttempts,
      error: error.message
    };
    console.log(JSON.stringify(result));
    process.exit(1);
  }
}

main();
