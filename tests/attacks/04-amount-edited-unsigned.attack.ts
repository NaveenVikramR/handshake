import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A04",
  title: "Cart total raised in transit without the agent key",
  category: "tamper",
  spec: "Amount changed after approval",
  expect: "AGENT_SIG_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const cart = h.cart(request);
    cart.items[0]!.unitMinor += 1000;
    cart.totalMinor += 1000;
    return h.submit(request);
  },
});
