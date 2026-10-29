import { verifyEnvelope, verifyPayload } from "./crypto.js";
import { HandshakeError } from "./errors.js";
import {
  paymentRequestSigningInput,
  type Authorization,
  type PaymentRequest,
  type SignedOffer,
  type SignedOfferRequest,
} from "./schemas.js";
import { checkFreshness } from "./time.js";

// Identity binding lives here, not in the schemas: a mismatch between who signed
// and who the payload names is a signature failure (SPEC §3, §6 steps 3–4).
// Inputs must already be schema-parsed. Each check throws a HandshakeError.

/** A registry row the caller has already looked up and confirmed active. */
export interface RegistryAgent {
  id: string;
  /** Ed25519 SPKI DER, base64url. */
  publicKey: string;
}

/**
 * Gate step 4 (signature + time part). OFFER_SIG_INVALID unless the offer is
 * signed by `merchantAgent`'s key and names that same agent; OFFER_EXPIRED past
 * `exp` (+ skew) or `holdUntil`. `now` is unix seconds.
 */
export function verifyOfferEnvelope(offer: SignedOffer, merchantAgent: RegistryAgent, now: number): void {
  if (offer.kid !== offer.payload.merchantAgentId || offer.kid !== merchantAgent.id) {
    throw new HandshakeError("OFFER_SIG_INVALID", "offer kid does not match the named merchant agent");
  }
  if (!verifyEnvelope(offer, merchantAgent.publicKey, merchantAgent.id, "offer")) {
    throw new HandshakeError("OFFER_SIG_INVALID", "offer signature invalid");
  }
  if (checkFreshness(offer.payload, now) !== "ok" || now > offer.payload.holdUntil) {
    throw new HandshakeError("OFFER_EXPIRED", "offer expired or hold released");
  }
}

/**
 * POST /offers. AGENT_SIG_INVALID unless the request is signed by `consumerAgent`'s key, names
 * that agent, is addressed to `merchantId` (no replay at another merchant) and is fresh.
 * The caller then records the nonce once.
 */
export function verifyOfferRequestEnvelope(
  req: SignedOfferRequest,
  consumerAgent: RegistryAgent,
  merchantId: string,
  now: number,
): void {
  if (req.kid !== req.payload.consumerAgentId || req.kid !== consumerAgent.id) {
    throw new HandshakeError("AGENT_SIG_INVALID", "offer request kid does not match the named consumer agent");
  }
  if (!verifyEnvelope(req, consumerAgent.publicKey, consumerAgent.id, "offer_request")) {
    throw new HandshakeError("AGENT_SIG_INVALID", "offer request signature invalid");
  }
  if (req.payload.merchantId !== merchantId) {
    throw new HandshakeError("AGENT_SIG_INVALID", "offer request addressed to another merchant");
  }
  if (checkFreshness(req.payload, now) !== "ok") {
    throw new HandshakeError("AGENT_SIG_INVALID", "offer request expired or not yet valid");
  }
}

function approvedConsumerAgents(a: Authorization): string[] {
  return a.kind === "passkey" ? [a.cartApproval.consumerAgentId] : [a.mandate.consumerAgentId, a.cart.consumerAgentId];
}

/**
 * Gate step 3 (signature part). AGENT_SIG_INVALID unless `agentSig` verifies
 * under `consumerAgent`'s key and every consumerAgentId the approval names is
 * that agent, so an approval cannot be re-wrapped by another registered agent.
 */
export function verifyPaymentRequestSig(req: PaymentRequest, consumerAgent: RegistryAgent): void {
  if (req.kid !== consumerAgent.id) {
    throw new HandshakeError("AGENT_SIG_INVALID", "request kid does not match registry agent");
  }
  if (!approvedConsumerAgents(req.authorization).every((id) => id === req.kid)) {
    throw new HandshakeError("AGENT_SIG_INVALID", "request signed by a different agent than the approval names");
  }
  if (!verifyPayload(paymentRequestSigningInput(req), req.agentSig, consumerAgent.publicKey)) {
    throw new HandshakeError("AGENT_SIG_INVALID", "agent signature invalid");
  }
}

/** Gate step 6b precondition: the mandate and the cart belong to the same user. */
export function checkMandateCartBinding(a: Authorization): void {
  if (a.kind === "mandate" && a.mandate.userId !== a.cart.userId) {
    throw new HandshakeError("MANDATE_INVALID", "mandate user does not match cart user");
  }
}
