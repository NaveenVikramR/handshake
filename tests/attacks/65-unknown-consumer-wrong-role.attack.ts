import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A65",
  title: "Registered agent whose role isn't consumer",
  category: "identity",
  spec: "Unknown consumer agent",
  expect: "AGENT_UNTRUSTED",
  reason: "not active in the registry",
  async run(h) {
    const { request } = await h.happyPathRequest();
    h.patchAgent("agt_c_wallet", { role: "merchant" });
    return h.submit(request);
  },
});
