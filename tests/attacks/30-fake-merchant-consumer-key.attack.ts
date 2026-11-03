import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A30",
  title: "Offer signed with the consumer agent's key",
  category: "identity",
  spec: "Fake merchant agent (unknown key)",
  expect: "OFFER_SIG_INVALID",
  reason: "offer signature invalid",
  async run(h) {
    const { request } = await h.happyPathRequest();
    return h.submit(h.resign({ ...request, offer: h.forgeOffer(request.offer, {}, h.f.keys.ck.privateKey) }));
  },
});
