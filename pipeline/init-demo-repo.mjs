import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const repoDir = join(root, "sandbox", "target-repo");

function run(cmd, args, cwd, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      env: process.env
    });

    let stderr = "";
    if (quiet) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} failed with code ${code}${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}

const repoPkg = {
  name: "target-repo",
  version: "0.0.0",
  private: true,
  type: "module",
  scripts: {
    test: "node --test",
    check: "node ./scripts/check.mjs"
  }
};

const mathSource = `export function add(a, b) {
  return a - b;
}

export function isEven(n) {
  return n % 2 === 1;
}
`;

const textSource = `export function titleCase(input) {
  return input
    .split(" ")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
`;

const addTest = `import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.js";

test("add should sum two numbers", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 2), 1);
});
`;

const isEvenTest = `import test from "node:test";
import assert from "node:assert/strict";
import { isEven } from "../src/math.js";

test("isEven should detect parity", () => {
  assert.equal(isEven(2), true);
  assert.equal(isEven(3), false);
});
`;

const titleCaseTest = `import test from "node:test";
import assert from "node:assert/strict";
import { titleCase } from "../src/text.js";

test("titleCase should normalize spaces", () => {
  assert.equal(titleCase("hello world"), "Hello World");
  assert.equal(titleCase("  hello   world  "), "Hello World");
});
`;

const checkScript = `import { readFile } from "node:fs/promises";

const files = ["src/math.js", "src/text.js"];
for (const file of files) {
  const content = await readFile(new URL("../" + file, import.meta.url), "utf8");
  if (content.includes("TODO")) {
    console.error(\`Check failed: TODO marker found in \${file}\`);
    process.exit(1);
  }
}
console.log("check ok");
`;

async function main() {
  await rm(repoDir, { recursive: true, force: true });

  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "test"), { recursive: true });
  await mkdir(join(repoDir, "scripts"), { recursive: true });

  await writeFile(join(repoDir, "package.json"), JSON.stringify(repoPkg, null, 2) + "\n", "utf8");
  await writeFile(join(repoDir, "src", "math.js"), mathSource, "utf8");
  await writeFile(join(repoDir, "src", "text.js"), textSource, "utf8");
  await writeFile(join(repoDir, "test", "add.test.js"), addTest, "utf8");
  await writeFile(join(repoDir, "test", "is-even.test.js"), isEvenTest, "utf8");
  await writeFile(join(repoDir, "test", "title-case.test.js"), titleCaseTest, "utf8");
  await writeFile(join(repoDir, "scripts", "check.mjs"), checkScript, "utf8");

  await run("git", ["init", "-b", "main"], repoDir);
  await run("git", ["config", "user.name", "Pipeline Demo"], repoDir);
  await run("git", ["config", "user.email", "pipeline-demo@example.com"], repoDir);
  await run("git", ["add", "."], repoDir);
  await run("git", ["commit", "-m", "chore: seed failing demo repository"], repoDir);

  console.log(`Initialized demo repo: ${repoDir}`);
  console.log("Next step: pnpm run run");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
