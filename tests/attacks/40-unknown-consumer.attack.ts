import { generateEd25519KeyPair } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A40",
  title: "Unregistered consumer agent with its own key",
  category: "identity",
  spec: "Unknown consumer agent",
  expect: "AGENT_UNTRUSTED",
  reason: "not active in the registry",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const key = generateEd25519KeyPair().privateKey;
    return h.submit(h.f.sign(request.offer, request.authorization, { kid: "agt_c_ghost", key }));
  },
});
