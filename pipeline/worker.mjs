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

async function applyTask(repoDir, task) {
  const filePath = join(repoDir, task.targetFile);
  const original = await readFile(filePath, "utf8");
  if (!original.includes(task.find)) {
    throw new Error(`Pattern not found in ${task.targetFile}`);
  }

  const updated = original.replace(task.find, task.replace);
  await writeFile(filePath, updated, "utf8");
}

async function main() {
  const repoDir = process.argv[2];
  const taskRaw = process.argv[3];

  if (!repoDir || !taskRaw) {
    console.error("Usage: node pipeline/worker.mjs <repoDir> '<task-json>'");
    process.exit(2);
  }

  const task = JSON.parse(taskRaw);

  try {
    await run("pnpm", ["install", "--silent"], repoDir);

    await applyTask(repoDir, task);

    const gateArgs = task.gateTest ? [gateScript, repoDir, task.gateTest] : [gateScript, repoDir];
    await run("node", gateArgs, repoDir);

    await run("git", ["add", task.targetFile], repoDir);
    await run("git", ["commit", "-m", task.commitMessage], repoDir);
    const { stdout } = await run("git", ["rev-parse", "HEAD"], repoDir, { capture: true });

    const result = {
      id: task.id,
      ok: true,
      commit: stdout.trim()
    };
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = {
      id: task.id,
      ok: false,
      error: error.message
    };
    console.log(JSON.stringify(result));
    process.exit(1);
  }
}

main();
