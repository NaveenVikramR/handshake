import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A02",
  title: "Cart total raised after approval, re-signed by the agent",
  category: "tamper",
  spec: "Amount changed after approval",
  expect: "CART_MISMATCH",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const cart = h.cart(request);
    cart.items[0]!.unitMinor += 1000;
    cart.totalMinor += 1000;
    return h.submit(h.resign(request));
  },
});
