import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A44",
  title: "Agent signature copied from another request",
  category: "identity",
  spec: "Forged agent sig",
  expect: "AGENT_SIG_INVALID",
  async run(h) {
    const a = await h.happyPathRequest();
    const b = await h.happyPathRequest();
    return h.submit({ ...a.request, agentSig: b.request.agentSig });
  },
});
