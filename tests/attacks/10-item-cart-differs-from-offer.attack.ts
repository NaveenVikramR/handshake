import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A10",
  title: "Human approved detergent, offer is rice",
  category: "tamper",
  spec: "Item swapped",
  expect: "CART_MISMATCH",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(
      h.f.passkeyRequest(offer, { items: [{ sku: "DET-1L", name: "Detergent 1 L", qty: 1, unitMinor: 650 }], totalMinor: 650 }),
    );
  },
});
