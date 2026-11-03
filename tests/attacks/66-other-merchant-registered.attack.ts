import { generateEd25519KeyPair } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A66",
  title: "Valid offer from another registered merchant sent to this gate",
  category: "identity",
  spec: "Approval for another merchant",
  expect: "OFFER_SIG_INVALID",
  reason: "not payable to this merchant",
  async run(h) {
    // A genuine merchant elsewhere, with its own registered key; the human really approved its cart.
    const other = generateEd25519KeyPair();
    h.addAgent({ id: "agt_m_other", role: "merchant", publicKey: other.publicKey, status: "active", merchantId: "mer_other" });
    const base = await h.f.offer();
    const offer = h.forgeOffer(
      base,
      { merchantId: "mer_other", merchantAgentId: "agt_m_other", paypalMerchantId: "PPOTHER1" },
      other.privateKey,
      "agt_m_other",
    );
    return h.submit(h.f.passkeyRequest(offer));
  },
});
