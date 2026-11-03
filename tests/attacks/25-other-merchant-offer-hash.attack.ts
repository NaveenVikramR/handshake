import { hash } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A25",
  title: "Approval bound to a different offer's hash",
  category: "identity",
  spec: "Approval for another merchant",
  expect: "CART_MISMATCH",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, { offerHash: hash({ offerId: "off_elsewhere" }) }));
  },
});
