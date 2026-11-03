import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A29",
  title: "Offer from an unregistered merchant agent",
  category: "identity",
  spec: "Fake merchant agent (unknown key)",
  expect: "OFFER_SIG_INVALID",
  reason: "not payable to this merchant",
  async run(h) {
    const { request } = await h.happyPathRequest();
    return h.submit(h.resign({ ...request, offer: h.forgeOffer(request.offer, {}, undefined, "agt_m_fake") }));
  },
});
