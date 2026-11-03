import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A39",
  title: "Offer issued to another consumer agent",
  category: "identity",
  spec: "Offer reuse",
  expect: "OFFER_SIG_INVALID",
  reason: "not issued by us to this agent",
  async run(h) {
    const offer = await h.f.offer();
    h.f.offerStore.offers.get(offer.payload.offerId)!.agentId = "agt_c_other";
    return h.submit(h.f.passkeyRequest(offer));
  },
});
