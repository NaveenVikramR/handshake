import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A41",
  title: "Consumer agent suspended in the registry",
  category: "identity",
  spec: "Unknown consumer agent",
  expect: "AGENT_UNTRUSTED",
  reason: "not active in the registry",
  async run(h) {
    const { request } = await h.happyPathRequest();
    h.patchAgent("agt_c_wallet", { status: "suspended" });
    return h.submit(request);
  },
});
