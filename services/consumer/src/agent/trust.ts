// Registry checks on the consumer side (SPEC §5.2 step 3). The agent card is only a hint: keys,
// merchant ids and PayPal merchant ids come from the trust registry.
import { HandshakeError, verifyOfferEnvelope, type SignedOffer } from "@handshake/core";
import type { RegistryMerchant, WalletStore } from "../store.js";

/** The merchant behind a merchant agent id, if both are active in the registry. Else MERCHANT_UNTRUSTED. */
export async function trustedMerchant(store: WalletStore, merchantAgentId: string): Promise<RegistryMerchant> {
  const agent = await store.getRegistryAgent(merchantAgentId);
  if (!agent || agent.role !== "merchant" || agent.status !== "active" || !agent.merchantId) {
    throw new HandshakeError("MERCHANT_UNTRUSTED", "merchant agent not active in the registry");
  }
  const [merchant] = await store.getMerchants([agent.merchantId]);
  if (!merchant || merchant.status !== "active") {
    throw new HandshakeError("MERCHANT_UNTRUSTED", "merchant not active in the registry");
  }
  return merchant;
}

/**
 * The offer is signed by the registry key of its merchant agent, that agent belongs to the merchant
 * the offer names, and the PayPal merchant id is that merchant's: merchantId ↔ merchantAgentId ↔
 * paypalMerchantId. `nowS` is unix seconds. Throws MERCHANT_UNTRUSTED / OFFER_SIG_INVALID / OFFER_EXPIRED.
 */
export async function verifyOfferWithRegistry(
  store: WalletStore,
  offer: SignedOffer,
  nowS: number,
): Promise<RegistryMerchant> {
  const agent = await store.getRegistryAgent(offer.kid);
  const merchant = await trustedMerchant(store, offer.kid);
  if (!agent) throw new HandshakeError("MERCHANT_UNTRUSTED", "merchant agent not in the registry");
  verifyOfferEnvelope(offer, { id: agent.id, publicKey: agent.publicKey }, nowS);
  if (offer.payload.merchantId !== merchant.id || offer.payload.paypalMerchantId !== merchant.paypalMerchantId) {
    throw new HandshakeError(
      "MERCHANT_UNTRUSTED",
      "offer names a merchant or PayPal account the registry doesn't link",
    );
  }
  return merchant;
}
