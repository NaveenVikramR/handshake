// Tampering builders (SPEC §11), shared by the attack suite (tests/attacks) and the dashboard's
// attack demo (DEMO_MODE). Each takes a valid object and changes one thing; none of them can make a
// request pass the gate, which is what the suite and the demo show.
import { generateEd25519KeyPair, signEnvelope, signPayload } from "./crypto.js";
import { paymentRequestSigningInput, type CartApproval, type PaymentRequest, type SignedOffer } from "./schemas.js";

/** "Amount changed after approval": the first line and the total raised by `byMinor`, items still summing up. */
export function raiseCart(cart: CartApproval, byMinor: number): CartApproval {
  const items = cart.items.map((i, n) => (n === 0 ? { ...i, unitMinor: i.unitMinor + byMinor } : { ...i }));
  return { ...cart, items, totalMinor: cart.totalMinor + byMinor * (cart.items[0]?.qty ?? 1) };
}

/** "Fake merchant agent": the offer re-signed by `key` (default: a key no registry has seen) under `kid`. */
export function forgeOffer(
  offer: SignedOffer,
  patch: Partial<SignedOffer["payload"]> = {},
  key?: string,
  kid?: string,
): SignedOffer {
  return signEnvelope(
    { ...offer.payload, ...patch },
    key ?? generateEd25519KeyPair().privateKey,
    kid ?? offer.kid,
  ) as SignedOffer;
}

/** A (tampered) request re-signed with the consumer agent's own key, as a compromised agent would. */
export function resignRequest(r: PaymentRequest, privateKey: string): PaymentRequest {
  const body = { requestId: r.requestId, offer: r.offer, authorization: r.authorization };
  return { ...r, agentSig: signPayload(paymentRequestSigningInput(body), privateKey) };
}
