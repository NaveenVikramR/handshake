import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A45",
  title: "Agent signature that isn't a signature",
  category: "identity",
  spec: "Forged agent sig",
  expect: "AGENT_SIG_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    return h.submit({ ...request, agentSig: "A".repeat(86) });
  },
});
