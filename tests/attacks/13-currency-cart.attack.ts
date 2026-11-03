import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A13",
  title: "Cart currency changed to EUR",
  category: "tamper",
  spec: "Currency swapped",
  expect: "SCHEMA_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    (h.cart(request) as { currency: string }).currency = "EUR";
    return h.submit(h.resign(request));
  },
});
