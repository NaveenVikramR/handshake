import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A09",
  title: "Approval for rice reused on a detergent offer",
  category: "tamper",
  spec: "Item swapped",
  expect: "CART_HASH_MISMATCH",
  async run(h) {
    const { request: approved } = await h.happyPathRequest();
    const det = await h.f.offer([{ sku: "DET-1L", qty: 1 }]);
    return h.submit(h.reuseApproval(approved, det));
  },
});
