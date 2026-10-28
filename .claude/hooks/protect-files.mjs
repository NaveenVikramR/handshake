// PreToolUse(Edit|Write): block writes to secrets and git internals.
import { basename } from "node:path";
import { readInput, block } from "./lib.mjs";

const input = readInput();
const filePath = String(input?.tool_input?.file_path ?? "").replace(/\\/g, "/");
if (!filePath) process.exit(0);

const name = basename(filePath);
const isEnv = /^\.env(\..+)?$/.test(name) && name !== ".env.example";

if (isEnv) block(`Blocked: ${name} holds secrets. Add new variables to .env.example and tell the user to copy them.`);
if (filePath.includes("/.git/")) block("Blocked: do not edit .git internals.");
if (/\/prisma\/migrations\/.+\/migration\.sql$/.test(filePath))
  block("Blocked: never hand-edit an applied migration. Create a new one with `pnpm db:migrate --name <change>`.");

process.exit(0);
