import { hash } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A07",
  title: "Ship-to replaced after approval, assertion kept",
  category: "tamper",
  spec: "Address changed after approval",
  expect: "CART_HASH_MISMATCH",
  async run(h) {
    const { request } = await h.happyPathRequest();
    h.cart(request).shipToHash = hash({ line1: "9 Elsewhere Rd" });
    return h.submit(h.resign(request));
  },
});
