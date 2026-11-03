import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A33",
  title: "Payee PayPal id swapped in a merchant-signed offer",
  category: "identity",
  spec: "Look-alike merchant id",
  expect: "OFFER_SIG_INVALID",
  reason: "not payable to this merchant",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const offer = h.forgeOffer(request.offer, { paypalMerchantId: "PPATTACKER1" }, h.f.keys.mk.privateKey);
    return h.submit(h.resign({ ...request, offer }));
  },
});
