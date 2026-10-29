import { CartApproval, IntentMandate, hash, periodStart, randomNonce } from "@handshake/core";
import { describe, expect, it } from "vitest";
import { decidePath, type PolicyInput } from "../src/agent/policy.js";
import type { StoredMandate } from "../src/store.js";

const now = 1_762_300_000;
const shipToHash = hash({ line1: "1 Main St" });
const assertion = { credentialId: "Y3JlZA", authenticatorData: "YQ", clientDataJSON: "Yg", signature: "Yw" };

const mandate = (patch: Partial<IntentMandate> = {}): StoredMandate => {
  const payload = IntentMandate.parse({
    v: 1,
    type: "intent_mandate",
    mandateId: "man_1",
    userId: "usr_alice",
    consumerAgentId: "agt_c_wallet",
    scope: { merchants: ["mer_corner"], categories: ["grocery"] },
    limits: { perOrderMinor: 3000, periodMinor: 8000, period: "week" },
    shipToHash,
    iat: now - 100,
    exp: now + 86400,
    nonce: randomNonce(),
    ...patch,
  });
  return {
    id: payload.mandateId,
    userId: payload.userId,
    payload,
    hash: hash(payload),
    status: "active",
    pendingUntil: 0,
    assertion,
  };
};

const cart = (totalMinor: number, patch: Partial<CartApproval> = {}) =>
  CartApproval.parse({
    v: 1,
    type: "cart_approval",
    offerId: "off_1",
    offerHash: hash({ o: 1 }),
    merchantId: "mer_corner",
    items: [{ sku: "RICE-2KG", name: "Rice", qty: 1, unitMinor: totalMinor }],
    totalMinor,
    currency: "USD",
    shipToHash,
    consumerAgentId: "agt_c_wallet",
    userId: "usr_alice",
    iat: now,
    exp: now + 300,
    nonce: randomNonce(),
    ...patch,
  });

const input = (c: CartApproval, mandates: StoredMandate[], spent = 0): PolicyInput => ({
  cart: c,
  categories: ["grocery"],
  mandates,
  spent: async (k) => (k.periodStart === periodStart("week", now) ? spent : 0),
  now,
});

describe("decidePath (code, not the LLM)", () => {
  it("within scope and limits → mandate", async () => {
    expect(await decidePath(input(cart(3000), [mandate()]))).toMatchObject({ path: "mandate" });
  });

  it("exactly reaching the period limit → mandate; one unit more → step-up", async () => {
    expect(await decidePath(input(cart(3000), [mandate()], 5000))).toMatchObject({ path: "mandate" });
    const d = await decidePath(input(cart(3000), [mandate()], 5001));
    expect(d.path).toBe("step_up");
    expect(JSON.stringify(d)).toContain("MANDATE_LIMIT");
  });

  it.each<[string, () => PolicyInput, string]>([
    ["no mandate", () => input(cart(100), []), "no active mandate"],
    ["over per-order", () => input(cart(3001), [mandate()]), "MANDATE_LIMIT"],
    ["new merchant", () => input(cart(100, { merchantId: "mer_other" }), [mandate()]), "MANDATE_SCOPE"],
    ["unusual category", () => ({ ...input(cart(100), [mandate()]), categories: ["electronics"] }), "MANDATE_SCOPE"],
    ["unknown category", () => ({ ...input(cart(100), [mandate()]), categories: [""] }), "MANDATE_SCOPE"],
    [
      "other ship-to",
      () => input(cart(100, { shipToHash: hash({ line1: "elsewhere" }) }), [mandate()]),
      "MANDATE_SCOPE",
    ],
    ["expired mandate", () => input(cart(100), [mandate({ iat: now - 9000, exp: now - 3600 })]), "MANDATE_INVALID"],
    ["pending mandate", () => input(cart(100), [{ ...mandate(), status: "pending" }]), "no active mandate"],
    [
      "mandate without stored proof",
      () => input(cart(100), [(({ assertion: _a, ...m }) => m)(mandate())]),
      "no active mandate",
    ],
  ])("%s → step-up (%s)", async (_n, make, reason) => {
    const d = await decidePath(make());
    expect(d.path).toBe("step_up");
    expect(JSON.stringify(d)).toContain(reason);
  });

  it("picks the first mandate that covers the cart", async () => {
    const narrow = mandate({
      mandateId: "man_narrow",
      limits: { perOrderMinor: 100, periodMinor: 100, period: "day" },
    });
    const wide = mandate({ mandateId: "man_wide" });
    expect(await decidePath(input(cart(2000), [narrow, wide]))).toMatchObject({
      path: "mandate",
      mandate: { id: "man_wide" },
    });
  });
});
