import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A11",
  title: "Item renamed on the approval screen (same sku and price)",
  category: "tamper",
  spec: "Item swapped",
  expect: "CART_MISMATCH",
  async run(h) {
    const offer = await h.f.offer();
    const item = offer.payload.items[0]!;
    return h.submit(h.f.passkeyRequest(offer, { items: [{ ...item, name: "Basmati rice 5 kg" }] }));
  },
});
