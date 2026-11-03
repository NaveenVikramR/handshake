// M6 follow-up: a real chat ends in a gate-issued receipt (real M7 gate, fake PayPal).
import { hash, shipToHash } from "@handshake/core";
import { afterEach, describe, expect, it } from "vitest";
import { verifyApproval } from "../src/approvals/service.js";
import { honestFinal, runChat } from "../src/agent/loop.js";
import type { PlannerMessage } from "../src/agent/planner.js";
import { STATUS_MEANING, type AgentEvent } from "../src/agent/tools.js";
import { activateMandate, createMandate } from "../src/mandates/service.js";
import { harness, lastResult, scriptedPlanner, shipTo, type Harness } from "./agent-harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const buy = (final: string) => [
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
  () => ({ content: final }),
];

async function mandated(hh: Harness) {
  const { userId, auth } = await hh.registerUser();
  const { mandateId, mandate } = await createMandate(hh.ctx, {
    userId,
    merchants: ["mer_corner"],
    categories: ["grocery"],
    perOrderMinor: 3000,
    periodMinor: 8000,
    period: "week",
    shipTo,
    days: 7,
  });
  await activateMandate(hh.ctx, mandateId, auth.assert(hash(mandate)));
  return { userId, auth };
}

async function chat(
  hh: Harness,
  userId: string,
  final: string,
  auth?: { assert: (c: string) => import("@handshake/core").WebAuthnAssertion },
) {
  const events: AgentEvent[] = [];
  await runChat(
    hh.ctx,
    { ...hh.agent, planner: scriptedPlanner(buy(final)) },
    { userId, message: "buy 1 rice", shipToHash: shipToHash(shipTo) },
    (e) => {
      events.push(e);
      if (e.type === "approval_required" && auth) {
        void (async () => {
          const a = await hh.store.getApproval(e.approvalId);
          await verifyApproval(hh.ctx, e.approvalId, auth.assert(a!.hash));
        })();
      }
    },
    { log: () => {} },
  );
  return events;
}

describe("chat → real gate", () => {
  it("first purchase: PayPal approval link (wallet saved), then a gate receipt; the next one needs no PayPal step", async () => {
    h = await harness();
    const { userId } = await mandated(h);
    const first = await chat(h, userId, "ok");
    expect(first.find((e) => e.type === "paypal_approval_required")).toMatchObject({
      url: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com\//),
    });
    const r1 = first.find((e) => e.type === "receipt");
    expect(r1).toMatchObject({ receipt: { status: "authorized", paypalOrderId: expect.any(String) } });
    expect((r1 as { receipt: { decisions: { step: string }[] } }).receipt.decisions.map((d) => d.step)).toContain("6b");

    const second = await chat(h, userId, "ok");
    expect(second.some((e) => e.type === "paypal_approval_required")).toBe(false);
    expect(second.find((e) => e.type === "receipt")).toMatchObject({ receipt: { status: "authorized" } });
  });

  it("the gate's risk check asks for step-up on the mandate path → the agent asks on the phone once, then pays", async () => {
    h = await harness();
    const { userId, auth } = await mandated(h);
    let calls = 0;
    h.gateCtx.risk = {
      inspect: async () => (calls++ === 0 ? { action: "step_up", reason: "odd" } : { action: "none", reason: "ok" }),
    };
    const events = await chat(h, userId, "ok", auth);
    expect(events.filter((e) => e.type === "path").map((e) => (e as { path: string }).path)).toEqual([
      "mandate",
      "step_up",
    ]);
    expect(JSON.stringify(events)).toContain("risk check asked for your approval");
    expect(events.find((e) => e.type === "receipt")).toMatchObject({ receipt: { status: "authorized" } });
    expect(h.paid.map((p) => p.request.authorization.kind)).toEqual(["passkey"]);
  });

  it("the final message can't call an authorized order complete or paid", async () => {
    h = await harness();
    const { userId } = await mandated(h);
    const events = await chat(h, userId, "Done! Your purchase is complete.");
    expect(events.at(-1)).toEqual({ type: "message", text: `Order status: ${STATUS_MEANING.authorized}.` });
  });

  it("honestFinal keeps accurate wording and allows 'paid' only after capture", () => {
    expect(honestFinal("Payment approved, held until delivery.", "authorized")).toBe(
      "Payment approved, held until delivery.",
    );
    expect(honestFinal("You have paid $4.99.", "authorized")).toBe(
      "Order status: payment approved, held until delivery.",
    );
    expect(honestFinal("You have paid $4.99.", "captured")).toBe("You have paid $4.99.");
    expect(honestFinal("Nothing bought yet.", undefined)).toBe("Nothing bought yet.");
  });
});
