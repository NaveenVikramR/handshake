import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A06",
  title: "Human shown a lower price than the signed offer",
  category: "tamper",
  spec: "Amount changed after approval",
  expect: "CART_MISMATCH",
  async run(h) {
    const offer = await h.f.offer();
    const item = offer.payload.items[0]!;
    return h.submit(h.f.passkeyRequest(offer, { items: [{ ...item, unitMinor: 500 }], totalMinor: 500 }));
  },
});
