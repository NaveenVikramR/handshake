import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A32",
  title: "Our key signs an offer naming a look-alike merchant",
  category: "identity",
  spec: "Look-alike merchant id",
  expect: "OFFER_SIG_INVALID",
  reason: "not payable to this merchant",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const offer = h.forgeOffer(request.offer, { merchantId: "mer_corner2" }, h.f.keys.mk.privateKey);
    return h.submit(h.resign({ ...request, offer }));
  },
});
