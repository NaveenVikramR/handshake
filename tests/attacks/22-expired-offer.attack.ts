import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A22",
  title: "Offer paid after its hold ran out",
  category: "replay",
  spec: "Expired approval",
  expect: "OFFER_EXPIRED",
  async run(h) {
    const offer = await h.f.offer();
    h.advance(20 * 60_000);
    return h.submit(h.f.passkeyRequest(offer));
  },
});
