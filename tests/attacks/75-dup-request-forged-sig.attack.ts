import { generateEd25519KeyPair } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A75",
  title: "Known requestId replayed under the original agent's id with a forged signature",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "AGENT_SIG_INVALID",
  authorizations: 1,
  async run(h) {
    const { request } = await h.happyPathRequest();
    await h.submit(request);
    const replay = h.f.sign(request.offer, request.authorization, {
      requestId: request.requestId,
      key: generateEd25519KeyPair().privateKey,
    });
    const res = await h.f.pay(replay);
    const body = res.body as Record<string, unknown>;
    const leaked = Object.keys(body).some((k) => k !== "error");
    return { code: leaked ? "RECEIPT_LEAKED" : String(body.error), authorized: false };
  },
});
