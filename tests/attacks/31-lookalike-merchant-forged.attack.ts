import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A31",
  title: "Look-alike merchant id with its own key",
  category: "identity",
  spec: "Look-alike merchant id",
  expect: "OFFER_SIG_INVALID",
  reason: "not payable to this merchant",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const offer = h.forgeOffer(request.offer, { merchantId: "mer_c0rner" }, undefined, "agt_m_c0rner");
    return h.submit(h.resign({ ...request, offer }));
  },
});
