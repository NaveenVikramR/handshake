// SessionStart(startup|resume|compact): print a compact orientation. Stdout is added to Claude's context.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectDir } from "./lib.mjs";

const out = [];
const planPath = join(projectDir, "docs", "PLAN.md");

if (existsSync(planPath)) {
  const lines = readFileSync(planPath, "utf8").split("\n");
  let heading = null;
  let found = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (found.length) break;
      heading = line;
    } else if (line.startsWith("- [ ]") && heading && !heading.includes("Stretch")) {
      found.push(line);
    }
  }
  if (found.length) out.push(`Current milestone: ${heading.replace("## ", "")}`, ...found.slice(0, 8));
  else out.push("All milestones in docs/PLAN.md are ticked.");
}

const git = (args) => {
  const r = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};
const status = git(["status", "--short"]).split("\n").filter(Boolean);
if (status.length) out.push(`Uncommitted (${status.length}):`, ...status.slice(0, 10));
const log = git(["log", "--oneline", "-3"]);
if (log) out.push("Recent commits:", log);

out.push("Reminder: sandbox PayPal only · LLM is escalate-only · read SPEC sections, not the whole file.");
process.stdout.write(out.join("\n") + "\n");
process.exit(0);
