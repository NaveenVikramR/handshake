import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A24",
  title: "Approval names another merchant",
  category: "identity",
  spec: "Approval for another merchant",
  expect: "CART_MISMATCH",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, { merchantId: "mer_other" }));
  },
});
