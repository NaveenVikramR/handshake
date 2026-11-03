import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A16",
  title: "Synced passkey (count 0) approval replayed on a reopened offer",
  category: "replay",
  spec: "Replayed approval",
  expect: "APPROVAL_REPLAY",
  authorizations: 1,
  options: { syncedPasskey: true },
  async run(h) {
    const { offer, request } = await h.happyPathRequest();
    await h.submit(request);
    // Even if the offer were open again, the cart nonce is spent.
    h.f.offerStore.offers.get(offer.payload.offerId)!.status = "open";
    return h.submit(h.f.sign(offer, request.authorization));
  },
});
