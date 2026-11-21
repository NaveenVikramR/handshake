// Stretch (D36): after a real chat → gate purchase, the merchant exports a signed evidence pack.
import { hash, shipToHash, verifyEnvelope } from "@handshake/core";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { runChat } from "../src/agent/loop.js";
import type { PlannerMessage } from "../src/agent/planner.js";
import { activateMandate, createMandate } from "../src/mandates/service.js";
import { harness, lastResult, scriptedPlanner, shipTo, type Harness } from "./agent-harness.js";

const ADMIN = "Bearer admin-token-0123456789abcdef";
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function buyOnMandate(hh: Harness): Promise<string> {
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
  await runChat(
    hh.ctx,
    {
      ...hh.agent,
      planner: scriptedPlanner([
        () => ({ calls: [["discover_merchants", {}]] }),
        () => ({ calls: [["request_offer", { merchantId: "mer_corner", items: [{ sku: "RICE-2KG", qty: 2 }] }]] }),
        (m: PlannerMessage[]) => ({ calls: [["checkout", { offerId: lastResult(m).offerId as string }]] }),
        () => ({ content: "ok" }),
      ]),
    },
    { userId, message: "buy rice", shipToHash: shipToHash(shipTo), shipTo },
    () => {},
    { log: () => {} },
  );
  const order = [...hh.gate.orders.values()].find((o) => o.status === "authorized");
  expect(order).toBeDefined();
  return order!.id;
}

describe("dispute evidence pack", () => {
  it("is merchant-signed, re-checks the offer, and ties the order to the approved cart", async () => {
    h = await harness();
    const orderId = await buyOnMandate(h);
    const r = await request(h.merchantUrl).get(`/orders/${orderId}/evidence`).set("authorization", ADMIN);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const pack = r.body;
    expect(verifyEnvelope(pack, h.merchantKeys.publicKey, "agt_m_corner", "dispute_evidence")).toBe(true);
    expect(pack.payload.checks).toEqual({
      offerHashMatchesOrder: true,
      offerSignatureValid: true,
      totalMatchesOffer: true,
    });
    expect(pack.payload.order).toMatchObject({ id: orderId, path: "mandate", status: "authorized" });
    expect(pack.payload.offer.payload.items[0]).toMatchObject({ sku: "RICE-2KG", qty: 2 });
    expect(pack.payload.approval.kind).toBe("mandate");
    expect(pack.payload.decisions.map((d: { step: string }) => d.step)).toContain("6b");
    expect(pack.payload.summary.join(" ")).toContain(pack.payload.order.amount);

    // Any edit after export breaks the merchant signature.
    const edited = structuredClone(pack);
    edited.payload.order.totalMinor = 1;
    expect(verifyEnvelope(edited, h.merchantKeys.publicKey, "agt_m_corner", "dispute_evidence")).toBe(false);
  });

  it("flags a stored offer that no longer matches the order instead of vouching for it", async () => {
    h = await harness();
    const orderId = await buyOnMandate(h);
    const order = h.gate.orders.get(orderId)!;
    const stored = h.offerStore.offers.get(order.offerId)!;
    stored.offer = {
      ...stored.offer,
      payload: { ...stored.offer.payload, totalMinor: stored.offer.payload.totalMinor + 100 },
    };
    const r = await request(h.merchantUrl).get(`/orders/${orderId}/evidence`).set("authorization", ADMIN);
    expect(r.body.payload.checks).toEqual({
      offerHashMatchesOrder: false,
      offerSignatureValid: false,
      totalMatchesOffer: false,
    });
  });

  it("needs the admin token, and an unknown order is 404", async () => {
    h = await harness();
    expect((await request(h.merchantUrl).get("/orders/ord_nope/evidence")).status).toBe(401);
    const r = await request(h.merchantUrl).get("/orders/ord_nope/evidence").set("authorization", ADMIN);
    expect(r.status).toBe(404);
    expect((await request(h.merchantUrl).get("/orders/bad id/evidence").set("authorization", ADMIN)).status).toBe(400);
  });
});
