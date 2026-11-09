import { raiseCart } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A02",
  title: "Cart total raised after approval, re-signed by the agent",
  category: "tamper",
  spec: "Amount changed after approval",
  expect: "CART_MISMATCH",
  async run(h) {
    const { request } = await h.happyPathRequest();
    if (request.authorization.kind !== "passkey") throw new Error("passkey request expected");
    const cartApproval = raiseCart(request.authorization.cartApproval, 1000);
    return h.submit(h.resign({ ...request, authorization: { ...request.authorization, cartApproval } }));
  },
});
