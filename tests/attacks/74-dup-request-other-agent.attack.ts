import { generateEd25519KeyPair } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A74",
  title: "Another registered agent replays a known requestId: no receipt",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "AGENT_UNTRUSTED",
  authorizations: 1,
  async run(h) {
    const { request } = await h.happyPathRequest();
    await h.submit(request);
    // A genuine, active consumer agent that didn't send the original.
    const other = generateEd25519KeyPair();
    h.addAgent({ id: "agt_c_other", role: "consumer", publicKey: other.publicKey, status: "active", merchantId: null });
    // Its own consistent request (cart naming itself), reusing only the leaked request id.
    const own = h.f.passkeyRequest(request.offer, { consumerAgentId: "agt_c_other" });
    const replay = h.f.sign(request.offer, own.authorization, {
      requestId: request.requestId,
      kid: "agt_c_other",
      key: other.privateKey,
    });
    const res = await h.f.pay(replay);
    const body = res.body as Record<string, unknown>;
    // Nothing but the error code comes back: no receipt, order or PayPal ids.
    const leaked = Object.keys(body).some((k) => k !== "error");
    // And the refusal stays out of the original request's decisions log.
    const polluted = h.f.gate.decisions.some((d) => d.requestId === request.requestId && d.result === "fail");
    return { code: leaked ? "RECEIPT_LEAKED" : polluted ? "LOG_POLLUTED" : String(body.error), authorized: false };
  },
});
