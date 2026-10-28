// PreToolUse(Bash): block commands that could hit live money, leak secrets, or destroy data.
import { readInput, block } from "./lib.mjs";

const cmd = String(readInput()?.tool_input?.command ?? "");
if (!cmd) process.exit(0);

const rules = [
  [/api(-m)?\.paypal\.com/i, "Live PayPal host. Use https://api-m.sandbox.paypal.com only."],
  [/\b(cat|less|more|head|tail|type|bat|grep|rg)\b[^|;&]*\.env(?!\.example)\b/, "Reading .env is not allowed. Ask the user for the value or use .env.example."],
  [/\bprintenv\b|\benv\s*$|\benv\s*\|/, "Dumping environment variables may leak secrets."],
  [/prisma\s+migrate\s+reset/, "prisma migrate reset wipes the database. Ask the user first."],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\.)(\s|$)/, "Recursive delete of a root/home/project directory."],
  [/git\s+push\s+.*(--force|-f\b)/, "Force push is not allowed."],
  [/git\s+reset\s+--hard/, "git reset --hard discards work. Ask the user first."],
];

for (const [re, reason] of rules) if (re.test(cmd)) block(`Blocked: ${reason}`);
process.exit(0);
