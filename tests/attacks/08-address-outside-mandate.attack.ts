import { hash } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A08",
  title: "Mandate order shipped to an address the mandate doesn't name",
  category: "mandate",
  spec: "Address changed after approval",
  expect: "MANDATE_SCOPE",
  async run(h) {
    const md = h.f.mandate();
    const offer = await h.f.offer();
    return h.submit(h.f.mandateRequest(offer, md, { shipToHash: hash({ line1: "9 Elsewhere Rd" }) }));
  },
});
