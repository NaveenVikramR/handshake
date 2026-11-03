import { paymentRequestSigningInput, signPayload } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A42",
  title: "Merchant agent's key and id used as a consumer",
  category: "identity",
  spec: "Unknown consumer agent",
  expect: "SCHEMA_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const body = { requestId: request.requestId, offer: request.offer, authorization: request.authorization };
    const agentSig = signPayload(paymentRequestSigningInput(body), h.f.keys.mk.privateKey);
    return h.submit({ ...body, kid: "agt_m_corner", agentSig });
  },
});
