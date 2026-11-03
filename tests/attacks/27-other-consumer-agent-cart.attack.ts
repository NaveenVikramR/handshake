import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A27",
  title: "Cart approved for another consumer agent",
  category: "identity",
  spec: "Approval for another merchant",
  expect: "AGENT_SIG_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, { consumerAgentId: "agt_c_other" }));
  },
});
