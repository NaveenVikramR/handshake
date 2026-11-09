// `pnpm render:*`: a small Render API client for the three Handshake services. Reads RENDER_API_KEY
// (and any --from-env value) from the root .env itself; never prints the key or a copied value, and
// redacts every .env value from log output it shows.
//   render:env-set <service> <KEY> --from-env <LOCAL_KEY>   copy a value from .env to the service
//   render:deploy <service>                               deploy the latest commit
//   render:status                                         latest deploy commit + status per service
//   render:logs <service> [n]                             last n log lines (default 20), redacted
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVICES = ["handshake-merchant", "handshake-consumer", "handshake-web"] as const;
const API = "https://api.render.com/v1";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const KEY = process.env.RENDER_API_KEY;

/** Every value in .env that is long enough to be a secret, longest first. */
const SECRETS = existsSync(envPath)
  ? readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map(
        (l) =>
          /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/
            .exec(l)?.[1]
            ?.trim()
            .replace(/^(['"])(.*)\1$/, "$2") ?? "",
      )
      .filter((v) => v.length >= 8)
      .sort((a, b) => b.length - a.length)
  : [];
const redact = (s: string) => SECRETS.reduce((out, v) => out.split(v).join("[redacted]"), s);

function fail(msg: string): never {
  console.error(redact(msg));
  process.exit(1);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!KEY) fail("set RENDER_API_KEY in .env");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface Service {
  id: string;
  name: string;
  ownerId: string;
}
async function service(name: string): Promise<Service> {
  if (!(SERVICES as readonly string[]).includes(name)) fail(`only ${SERVICES.join(", ")}`);
  const rows = await api<{ service: Service }[]>("GET", `/services?name=${encodeURIComponent(name)}&limit=20`);
  const s = rows.map((r) => r.service).find((x) => x.name === name);
  if (!s) fail(`service ${name} not found`);
  return s;
}

interface Deploy {
  id: string;
  status: string;
  commit?: { id?: string; message?: string };
  createdAt?: string;
  finishedAt?: string;
}
async function latestDeploy(s: Service): Promise<Deploy | undefined> {
  const rows = await api<{ deploy: Deploy }[]>("GET", `/services/${s.id}/deploys?limit=1`);
  return rows[0]?.deploy;
}

async function envSet(name: string, key: string, localKey: string): Promise<void> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || !/^[A-Z_][A-Z0-9_]*$/.test(localKey)) fail("keys are UPPER_SNAKE_CASE");
  const value = process.env[localKey];
  if (!value) fail(`${localKey} is not set in .env`);
  const s = await service(name);
  await api("PUT", `/services/${s.id}/env-vars/${key}`, { value });
  console.log(`${name}: ${key} set from .env ${localKey} (${value.length} chars; takes effect on the next deploy)`);
}

async function deploy(name: string): Promise<void> {
  const s = await service(name);
  const d = await api<Deploy>("POST", `/services/${s.id}/deploys`, { clearCache: "do_not_clear" });
  console.log(`${name}: deploy ${d.id} ${d.status}`);
}

async function status(): Promise<void> {
  for (const name of SERVICES) {
    const d = await latestDeploy(await service(name));
    const commit = d?.commit?.id?.slice(0, 7) ?? "-------";
    const msg = (d?.commit?.message ?? "").split("\n")[0]?.slice(0, 60);
    console.log(`${name.padEnd(20)} ${commit} ${(d?.status ?? "none").padEnd(20)} ${msg}`);
  }
}

async function logs(name: string, n: number): Promise<void> {
  const s = await service(name);
  const q = new URLSearchParams({ ownerId: s.ownerId, direction: "backward", limit: String(n) });
  q.append("resource", s.id);
  const r = await api<{ logs?: { message: string; timestamp: string }[] }>("GET", `/logs?${q}`);
  for (const l of (r.logs ?? []).reverse()) console.log(redact(`${l.timestamp} ${l.message}`));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "env-set") {
  const i = args.indexOf("--from-env");
  const [name, key] = args;
  const localKey = i >= 0 ? args[i + 1] : undefined;
  if (!name || !key || !localKey) fail("usage: render:env-set <service> <KEY> --from-env <LOCAL_KEY>");
  await envSet(name, key, localKey);
} else if (cmd === "deploy") {
  if (!args[0]) fail("usage: render:deploy <service>");
  await deploy(args[0]);
} else if (cmd === "status") {
  await status();
} else if (cmd === "logs") {
  if (!args[0]) fail("usage: render:logs <service> [n]");
  await logs(args[0], Number(args[1] ?? 20));
} else {
  fail("commands: env-set, deploy, status, logs");
}
