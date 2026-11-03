import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A36",
  title: "Merchant re-signs the same offer id at a higher price",
  category: "tamper",
  spec: "Merchant price change after offer",
  expect: "OFFER_SIG_INVALID",
  reason: "not issued by us to this agent",
  async run(h) {
    const offer = await h.f.offer();
    const p = offer.payload;
    const higher = h.forgeOffer(
      offer,
      { items: p.items.map((i) => ({ ...i, unitMinor: i.unitMinor * 2 })), totalMinor: p.totalMinor * 2 },
      h.f.keys.mk.privateKey,
    );
    // The human even approves the higher cart: the stored offer hash still disagrees.
    return h.submit(h.f.passkeyRequest(higher));
  },
});
