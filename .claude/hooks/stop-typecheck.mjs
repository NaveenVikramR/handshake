// Stop: if TypeScript files changed, run the typecheck once and send errors back to Claude.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readInput, projectDir } from "./lib.mjs";

const input = readInput();
if (input?.stop_hook_active) process.exit(0); // already continued once; let Claude stop

const pkgPath = join(projectDir, "package.json");
if (!existsSync(pkgPath)) process.exit(0);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (!pkg?.scripts?.typecheck) process.exit(0);

const git = spawnSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8" });
if (git.status !== 0) process.exit(0);
const changedTs = git.stdout.split("\n").some((l) => /\.(ts|tsx)$/.test(l.trim()));
if (!changedTs) process.exit(0);

const r = spawnSync("pnpm", ["-s", "typecheck"], {
  cwd: projectDir,
  encoding: "utf8",
  timeout: 150_000,
  shell: process.platform === "win32",
});
if (r.status === 0) process.exit(0);

const errors = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.includes("error")).slice(0, 30).join("\n");
process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason: `Typecheck failed. Fix these before finishing (showing up to 30):\n${errors || "(run pnpm typecheck for details)"}`,
  }),
);
process.exit(0);
