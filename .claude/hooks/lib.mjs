// Shared helpers for hook scripts. Hooks receive event JSON on stdin.
import { readFileSync } from "node:fs";

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

export function block(message) {
  process.stderr.write(message + "\n");
  process.exit(2); // exit 2 = block the tool call; stderr is shown to Claude
}

export const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
