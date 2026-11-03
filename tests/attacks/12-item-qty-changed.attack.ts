import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A12",
  title: "Quantity raised in the cart, totals kept consistent",
  category: "tamper",
  spec: "Item swapped",
  expect: "CART_MISMATCH",
  async run(h) {
    const offer = await h.f.offer();
    const item = offer.payload.items[0]!;
    return h.submit(h.f.passkeyRequest(offer, { items: [{ ...item, qty: 2 }], totalMinor: item.unitMinor * 2 }));
  },
});
