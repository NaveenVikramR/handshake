import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { AssertOptions } from "../../../packages/core/test/fake-authenticator.js";
import { SESSION_TTL_MS, tokenHash } from "../src/sessions/service.js";
import { harness, scriptedPlanner, type Harness } from "./agent-harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function login(
  hh: Harness,
  userId: string,
  auth: Awaited<ReturnType<Harness["registerUser"]>>["auth"],
  opts: AssertOptions = {},
) {
  const o = await request(hh.app).post("/passkeys/login/options").send({ userId });
  expect(o.status).toBe(200);
  expect(o.body.options.userVerification).toBe("required");
  const v = await request(hh.app)
    .post("/passkeys/login/verify")
    .send({ loginId: o.body.loginId, response: auth.assertJSON(o.body.options.challenge, opts) });
  return { options: o.body, verify: v };
}

describe("passkey login", () => {
  it("a UV assertion over the login challenge issues a session; only its hash is stored", async () => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const { verify } = await login(h, userId, auth);
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ userId, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(await h.store.getSessionUser(verify.body.token, Date.now())).toBeUndefined();
    expect(await h.store.getSessionUser(tokenHash(verify.body.token), Date.now())).toBe(userId);
  });

  it.each<[string, AssertOptions, string]>([
    ["UV missing", { uv: false }, "APPROVAL_UV_MISSING"],
    ["wrong origin", { origin: "https://evil.example" }, "APPROVAL_INVALID"],
    ["tampered signature", { tamperSignature: true }, "APPROVAL_INVALID"],
  ])("%s → 401 %s, no session", async (_n, opts, code) => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const { verify } = await login(h, userId, auth, opts);
    expect(verify.status).toBe(401);
    expect(verify.body).toEqual({ error: code });
  });

  it("an unknown user gets the same shape of options, with a stable decoy credential; verify fails like an expiry (M10)", async () => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const ghost = "usr_AAAAAAAAAAAAAAAAAAAAAA";
    const real = await request(h.app).post("/passkeys/login/options").send({ userId });
    const fake1 = await request(h.app).post("/passkeys/login/options").send({ userId: ghost });
    const fake2 = await request(h.app).post("/passkeys/login/options").send({ userId: ghost });
    expect(fake1.status).toBe(200);
    expect(Object.keys(fake1.body).sort()).toEqual(Object.keys(real.body).sort());
    expect(Object.keys(fake1.body.options).sort()).toEqual(Object.keys(real.body.options).sort());
    expect(fake1.body.options.allowCredentials).toHaveLength(1);
    expect(fake2.body.options.allowCredentials).toEqual(fake1.body.options.allowCredentials);
    // Nothing was stored for the ghost: verify answers as for an expired login.
    const v = await request(h.app)
      .post("/passkeys/login/verify")
      .send({ loginId: fake1.body.loginId, response: auth.assertJSON(fake1.body.options.challenge) });
    expect(v.body).toEqual({ error: "APPROVAL_EXPIRED" });
  });

  it("login options are limited per user id, the same for known and unknown users (M10)", async () => {
    h = await harness();
    const { userId } = await h.registerUser();
    for (const id of [userId, "usr_BBBBBBBBBBBBBBBBBBBBBB"]) {
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await request(h.app).post("/passkeys/login/options").send({ userId: id })).status);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    }
  });

  it("a login challenge works once", async () => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const { options, verify } = await login(h, userId, auth);
    expect(verify.status).toBe(200);
    const again = await request(h.app)
      .post("/passkeys/login/verify")
      .send({ loginId: options.loginId, response: auth.assertJSON(options.options.challenge) });
    expect(again.body).toEqual({ error: "APPROVAL_EXPIRED" });
  });

  it("another user's passkey can't open this user's session", async () => {
    h = await harness();
    const alice = await h.registerUser();
    const bob = await h.registerUser();
    const o = await request(h.app).post("/passkeys/login/options").send({ userId: alice.userId });
    const v = await request(h.app)
      .post("/passkeys/login/verify")
      .send({ loginId: o.body.loginId, response: bob.auth.assertJSON(o.body.options.challenge) });
    expect(v.status).toBe(401);
    expect(v.body).toEqual({ error: "APPROVAL_INVALID" });
  });
});

describe("POST /chat", () => {
  const sse = (text: string) =>
    text
      .split("\n\n")
      .filter(Boolean)
      .map(
        (block) =>
          JSON.parse(
            block
              .split("\n")
              .find((l) => l.startsWith("data: "))!
              .slice(6),
          ) as { type: string },
      );

  it.each([
    ["no token", undefined],
    ["a malformed token", "Bearer nope"],
    ["an unknown token", `Bearer ${"A".repeat(43)}`],
  ])("401 with %s", async (_n, auth) => {
    h = await harness();
    const r = request(h.app).post("/chat").send({ message: "hi" });
    const res = auth ? await r.set("authorization", auth) : await r;
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("an expired session → 401", async () => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const { verify } = await login(h, userId, auth);
    const real = h.ctx.now;
    h.ctx.now = () => real() + SESSION_TTL_MS + 1;
    const res = await request(h.app)
      .post("/chat")
      .set("authorization", `Bearer ${verify.body.token}`)
      .send({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it("the user comes from the session: a userId in the body is rejected", async () => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const { verify } = await login(h, userId, auth);
    const res = await request(h.app)
      .post("/chat")
      .set("authorization", `Bearer ${verify.body.token}`)
      .send({ message: "hi", userId: "usr_someoneelse0000000000" });
    expect(res.body).toEqual({ error: "SCHEMA_INVALID" });
  });

  it("streams the agent's events as SSE for the signed-in user", async () => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const { verify } = await login(h, userId, auth);
    h.agent.planner = scriptedPlanner([
      () => ({ calls: [["discover_merchants", {}]] }),
      () => ({ content: "Found one." }),
    ]);
    const res = await request(h.app)
      .post("/chat")
      .set("authorization", `Bearer ${verify.body.token}`)
      .send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = sse(res.text);
    expect(events.map((e) => e.type)).toEqual(["tool", "tool_result", "message", "done"]);
  });
});
