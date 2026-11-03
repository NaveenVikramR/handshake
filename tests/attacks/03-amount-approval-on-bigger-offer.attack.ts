import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A03",
  title: "Approval for 1 item reused on a signed offer for 3",
  category: "tamper",
  spec: "Amount changed after approval",
  expect: "CART_HASH_MISMATCH",
  async run(h) {
    const { request: approved } = await h.happyPathRequest();
    const bigger = await h.f.offer([{ sku: "RICE-2KG", qty: 3 }]);
    return h.submit(h.reuseApproval(approved, bigger));
  },
});
