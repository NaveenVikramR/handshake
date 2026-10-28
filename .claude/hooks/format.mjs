// PostToolUse(Edit|Write): format the edited file with the project's Prettier, silently.
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { readInput, projectDir } from "./lib.mjs";

const file = readInput()?.tool_input?.file_path;
if (!file || !/\.(ts|tsx|js|mjs|cjs|json|css|md)$/.test(extname(file))) process.exit(0);

const bin = join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier");
if (!existsSync(bin)) process.exit(0);

spawnSync(bin, ["--write", "--log-level", "silent", file], { cwd: projectDir, stdio: "ignore", shell: process.platform === "win32" });
process.exit(0);
