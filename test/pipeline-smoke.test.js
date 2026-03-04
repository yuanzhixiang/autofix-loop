import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const keyPipelineFiles = [
  "pipeline/dispatcher.mjs",
  "pipeline/worker.mjs",
  "pipeline/gate.mjs"
];

const importProbeScript = `
const moduleUrl = process.argv[1];
const originalExit = process.exit;

process.exit = (code = 0) => {
  const error = new Error(String(code));
  error.name = "SmokeExit";
  throw error;
};

try {
  await import(moduleUrl);
  originalExit(0);
} catch (error) {
  if (error && error.name === "SmokeExit") {
    originalExit(0);
  }

  console.error(error);
  originalExit(1);
}
`;

function importInSubprocess(moduleUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", importProbeScript, moduleUrl],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("key pipeline files exist", async () => {
  for (const relativePath of keyPipelineFiles) {
    await access(path.join(repoRoot, relativePath));
  }
});

test("key pipeline files can be imported without uncaught exceptions", async () => {
  for (const relativePath of keyPipelineFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    const moduleUrl = pathToFileURL(absolutePath).href;
    const result = await importInSubprocess(moduleUrl);

    assert.equal(
      result.code,
      0,
      `${relativePath} import smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
});
