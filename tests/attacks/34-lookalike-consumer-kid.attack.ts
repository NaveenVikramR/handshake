import { generateEd25519KeyPair } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A34",
  title: "Look-alike consumer agent id",
  category: "identity",
  spec: "Look-alike merchant id",
  expect: "AGENT_UNTRUSTED",
  reason: "not active in the registry",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const key = generateEd25519KeyPair().privateKey;
    return h.submit(h.f.sign(request.offer, request.authorization, { kid: "agt_c_wa11et", key }));
  },
});
