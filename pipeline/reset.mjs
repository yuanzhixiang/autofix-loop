import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
await rm(join(root, "sandbox", "target-repo"), { recursive: true, force: true });
await rm(join(root, "sandbox", "worktrees"), { recursive: true, force: true });
console.log("reset done");
