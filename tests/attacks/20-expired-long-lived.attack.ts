import { hash, paymentRequestSigningInput, randomNonce, signPayload } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A20",
  title: "Approval valid for an hour (over the 5-minute cap), really signed by the passkey",
  category: "replay",
  spec: "Expired approval",
  expect: "SCHEMA_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    const now = Math.floor(h.f.clock.t / 1000);
    const cart = { ...h.f.cartFor(offer), exp: now + 3600 };
    const body = { requestId: `req_${randomNonce()}`, offer, authorization: { kind: "passkey", cartApproval: cart, assertion: h.f.auth.assert(hash(cart)) } };
    return h.submit({ ...body, kid: "agt_c_wallet", agentSig: signPayload(paymentRequestSigningInput(body as never), h.f.keys.ck.privateKey) });
  },
});
