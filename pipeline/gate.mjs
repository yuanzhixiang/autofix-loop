import { spawn } from "node:child_process";

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: process.env
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

async function main() {
  const repoDir = process.argv[2];
  const testTarget = process.argv[3];
  if (!repoDir) {
    console.error("Usage: node pipeline/gate.mjs <repoDir> [testFile]");
    process.exit(2);
  }

  const testArgs = testTarget ? ["test", "--", testTarget] : ["test"];
  const testOk = await run("pnpm", testArgs, repoDir);
  if (!testOk) {
    process.exit(1);
  }

  const checkOk = await run("pnpm", ["check"], repoDir);
  if (!checkOk) {
    process.exit(1);
  }

  process.exit(0);
}

main();
