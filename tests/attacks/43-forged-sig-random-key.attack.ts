import { generateEd25519KeyPair } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A43",
  title: "Agent signature from a random key",
  category: "identity",
  spec: "Forged agent sig",
  expect: "AGENT_SIG_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    return h.submit(h.f.sign(request.offer, request.authorization, { key: generateEd25519KeyPair().privateKey }));
  },
});
