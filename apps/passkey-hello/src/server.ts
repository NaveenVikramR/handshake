// M0 spike: prove passkey register + login works on a phone over HTTPS (Render). In-memory, throwaway.
// The real cart-bound approval flow lands in services/consumer in M3.
import { fileURLToPath } from "node:url";
import express from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

// Render injects RENDER_EXTERNAL_URL (https://<service>.onrender.com); explicit env wins.
const origin = process.env.WEBAUTHN_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:3000";
const rpID = process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname;
const rpName = process.env.WEBAUTHN_RP_NAME ?? "Handshake";
const port = Number(process.env.PORT ?? 3000);

if (process.env.NODE_ENV === "production" && !process.env.WEBAUTHN_ORIGIN && !process.env.RENDER_EXTERNAL_URL) {
  throw new Error("WEBAUTHN_ORIGIN (or RENDER_EXTERNAL_URL) must be set in production");
}

const MAX_USERS = 500;
const MAX_PENDING = 1000;
const CHALLENGE_TTL_MS = 5 * 60_000;

interface User {
  credentials: WebAuthnCredential[];
}

const users = new Map<string, User>();
// One pending challenge per username; expires after 5 min and is deleted on first use so it can't be replayed.
const challenges = new Map<string, { challenge: string; exp: number }>();

function putChallenge(username: string, challenge: string): boolean {
  const now = Date.now();
  for (const [name, c] of challenges) if (c.exp < now) challenges.delete(name);
  if (!challenges.has(username) && challenges.size >= MAX_PENDING) return false;
  challenges.set(username, { challenge, exp: now + CHALLENGE_TTL_MS });
  return true;
}

function takeChallenge(username: string): string | undefined {
  const c = challenges.get(username);
  challenges.delete(username);
  return c && c.exp >= Date.now() ? c.challenge : undefined;
}

function readUsername(body: unknown): string | undefined {
  const name = (body as { username?: unknown } | undefined)?.username;
  return typeof name === "string" && /^[\w.@-]{1,64}$/.test(name) ? name : undefined;
}

const browserBundle = fileURLToPath(
  new URL("../dist/bundle/index.umd.min.js", import.meta.resolve("@simplewebauthn/browser")),
);

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
// dotfiles: "allow" because pnpm stores deps under node_modules/.pnpm.
app.get("/vendor/simplewebauthn-browser.js", (_req, res) => res.sendFile(browserBundle, { dotfiles: "allow" }));
app.get("/healthz", (_req, res) => res.json({ ok: true, rpID, origin }));

app.post("/register/options", async (req, res) => {
  const username = readUsername(req.body);
  if (!username) return void res.status(400).json({ error: "invalid username" });
  // No sessions in this spike, so a taken username can't prove ownership: never add credentials to it.
  if (users.has(username)) return void res.status(409).json({ error: "username taken — pick another" });
  if (users.size >= MAX_USERS) return void res.status(503).json({ error: "demo is full" });
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  if (!putChallenge(username, options.challenge)) return void res.status(503).json({ error: "busy, retry" });
  res.json(options);
});

app.post("/register/verify", async (req, res) => {
  const username = readUsername(req.body);
  const expectedChallenge = username && takeChallenge(username);
  if (!username || !expectedChallenge) return void res.status(400).json({ error: "no pending registration" });
  try {
    const result = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) return void res.status(400).json({ verified: false });
    if (users.has(username)) return void res.status(409).json({ error: "username taken — pick another" });
    users.set(username, { credentials: [result.registrationInfo.credential] });
    res.json({ verified: true, credentialId: result.registrationInfo.credential.id });
  } catch (err) {
    console.error("register verify failed:", (err as Error).message);
    res.status(400).json({ verified: false, error: "registration could not be verified" });
  }
});

app.post("/login/options", async (req, res) => {
  const username = readUsername(req.body);
  const user = username ? users.get(username) : undefined;
  if (!username || !user) return void res.status(404).json({ error: "unknown user — register first" });
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: user.credentials.map((c) => ({
      id: c.id,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
  });
  if (!putChallenge(username, options.challenge)) return void res.status(503).json({ error: "busy, retry" });
  res.json(options);
});

app.post("/login/verify", async (req, res) => {
  const username = readUsername(req.body);
  const user = username ? users.get(username) : undefined;
  const expectedChallenge = username && takeChallenge(username);
  if (!username || !user || !expectedChallenge) return void res.status(400).json({ error: "no pending login" });
  const credential = user.credentials.find((c) => c.id === req.body.response?.id);
  if (!credential) return void res.status(400).json({ verified: false, error: "unknown credential" });
  try {
    const result = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential,
      requireUserVerification: true,
    });
    if (!result.verified) return void res.status(400).json({ verified: false });
    const { newCounter, userVerified } = result.authenticationInfo;
    // Library rejects a non-increasing counter unless both are 0 (platform authenticators that don't count).
    credential.counter = newCounter;
    res.json({ verified: true, userVerified, signCount: newCounter });
  } catch (err) {
    console.error("login verify failed:", (err as Error).message);
    res.status(400).json({ verified: false, error: "login could not be verified" });
  }
});

app.listen(port, () => console.log(`passkey-hello on :${port} (rpID=${rpID}, origin=${origin})`));
