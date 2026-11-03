import { generateEd25519KeyPair } from "../../packages/core/src/index.js";
import request from "supertest";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A77",
  title: "/complete for a leaked requestId signed by another registered agent",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "UNKNOWN_REQUEST",
  authorizations: 1,
  async run(h) {
    const { request: pr } = await h.happyPathRequest();
    await h.submit(pr);
    const other = generateEd25519KeyPair();
    h.addAgent({ id: "agt_c_other", role: "consumer", publicKey: other.publicKey, status: "active", merchantId: null });
    const own = h.f.passkeyRequest(pr.offer, { consumerAgentId: "agt_c_other" });
    const signed = h.f.sign(pr.offer, own.authorization, { requestId: pr.requestId, kid: "agt_c_other", key: other.privateKey });
    const res = await request(h.f.app).post(`/payments/${pr.requestId}/complete`).send(signed);
    const body = res.body as Record<string, unknown>;
    const leaked = Object.keys(body).some((k) => k !== "error");
    return { code: leaked ? "RECEIPT_LEAKED" : String(body.error), authorized: false };
  },
});
