// M10 attack demo: real tampered requests from this agent to the real gate (fake PayPal) are refused.
import { shipToHash } from "@handshake/core";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { verifyApproval } from "../src/approvals/service.js";
import { runChat } from "../src/agent/loop.js";
import type { PlannerMessage } from "../src/agent/planner.js";
import { createApp } from "../src/app.js";
import { runAttack } from "../src/demo/attacks.js";
import { harness, lastResult, scriptedPlanner, shipTo, type Harness } from "./agent-harness.js";

const SECRET = "demo-secret-0123456789";
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** One honest step-up purchase: the human approves the cart on the phone. */
async function approvedPurchase(hh: Harness) {
  const { userId, auth } = await hh.registerUser();
  const steps = [
    () => ({ calls: [["discover_merchants", {}]] as [string, object][] }),
    () => ({
      calls: [["request_offer", { merchantId: "mer_corner", items: [{ sku: "RICE-2KG", qty: 1 }] }]] as [
        string,
        object,
      ][],
    }),
    (m: PlannerMessage[]) => ({
      calls: [["checkout", { offerId: lastResult(m).offerId as string }]] as [string, object][],
    }),
    () => ({ content: "ok" }),
  ];
  await runChat(
    hh.ctx,
    { ...hh.agent, planner: scriptedPlanner(steps) },
    { userId, message: "buy 1 rice", shipToHash: shipToHash(shipTo), shipTo },
    (e) => {
      if (e.type === "approval_required") {
        void (async () => {
          const a = await hh.store.getApproval(e.approvalId);
          await verifyApproval(hh.ctx, e.approvalId, auth.assert(a!.hash));
        })();
      }
    },
    { log: () => {} },
  );
  expect(hh.paid).toHaveLength(1);
}

describe("attack demo (DEMO_MODE)", () => {
  it("amount changed after approval → CART_MISMATCH, nothing paid", async () => {
    h = await harness();
    expect(await runAttack(h.ctx, "amount")).toMatchObject({ kind: "amount", code: "CART_MISMATCH" });
    expect(h.paid).toHaveLength(0);
  });

  it("fake merchant agent (offer re-signed by an unknown key) → OFFER_SIG_INVALID", async () => {
    h = await harness();
    expect(await runAttack(h.ctx, "merchant")).toMatchObject({ code: "OFFER_SIG_INVALID" });
    expect(h.paid).toHaveLength(0);
  });

  it("replayed approval: a real, used approval sent again under a new request id → OFFER_USED", async () => {
    h = await harness();
    await approvedPurchase(h);
    const r = await runAttack(h.ctx, "replay");
    expect(r.code).toBe("OFFER_USED");
    expect(h.paid).toHaveLength(1);
    // The gate logged it as a refused request of its own.
    expect(h.gate.decisions.some((d) => d.requestId === r.requestId && d.result === "fail")).toBe(true);
  });

  it("an approval the human signed but the gate never got is never replayed (review HIGH)", async () => {
    h = await harness();
    const { userId } = await h.registerUser();
    const cred = (await h.store.listCredentials(userId))[0]!;
    // Approved on the phone, but the chat dropped before the agent submitted it: the offer is unused.
    await h.store.createApproval({
      id: "apr_unsent",
      userId,
      payload: {} as never,
      hash: "h-unsent",
      expiresAt: Date.now() + 60_000,
      offer: {} as never,
    });
    expect(
      await h.store.completeApproval({
        id: "apr_unsent",
        credentialId: cred.credentialId,
        expectedSignCount: cred.signCount,
        newSignCount: cred.signCount + 1,
        assertion: { credentialId: "a", authenticatorData: "b", clientDataJSON: "c", signature: "d" },
        now: Date.now(),
      }),
    ).toBe(true);
    await expect(runAttack(h.ctx, "replay")).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(h.gate.decisions).toHaveLength(0);
  });

  it("replay before any approved purchase: says so, sends nothing", async () => {
    h = await harness();
    await expect(runAttack(h.ctx, "replay")).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("route: needs the demo secret, known kinds only, rate-limited, absent without a secret", async () => {
    h = await harness();
    const app = createApp(h.ctx, { demoSecret: SECRET });
    expect((await request(app).post("/demo/attack/amount")).status).toBe(401);
    expect((await request(app).post("/demo/attack/amount").set("x-demo-secret", `${SECRET}x`)).status).toBe(401);
    expect((await request(app).post("/demo/attack/other").set("x-demo-secret", SECRET)).status).toBe(404);
    const ok = await request(app).post("/demo/attack/amount").set("x-demo-secret", SECRET);
    expect(ok.body).toMatchObject({ kind: "amount", code: "CART_MISMATCH" });
    for (let i = 0; i < 5; i++) await request(app).post("/demo/attack/merchant").set("x-demo-secret", SECRET);
    expect((await request(app).post("/demo/attack/merchant").set("x-demo-secret", SECRET)).status).toBe(429);
    expect((await request(createApp(h.ctx)).post("/demo/attack/amount").set("x-demo-secret", SECRET)).status).toBe(404);
  });
});
