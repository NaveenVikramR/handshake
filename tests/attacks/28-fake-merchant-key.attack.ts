import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A28",
  title: "Offer re-signed by an unknown key under our merchant kid",
  category: "identity",
  spec: "Fake merchant agent (unknown key)",
  expect: "OFFER_SIG_INVALID",
  reason: "offer signature invalid",
  async run(h) {
    const { request } = await h.happyPathRequest();
    return h.submit(h.resign({ ...request, offer: h.forgeOffer(request.offer, {}) }));
  },
});
