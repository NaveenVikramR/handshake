import { z } from "zod";

// SPEC §3–4. Every object is strict: unknown keys are rejected so that nothing
// unsigned or unhashed can ride along with a payload.

export const MAX_CART_APPROVAL_TTL_S = 300;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/, "base64url");
/** base64url SHA-256 digest (32 bytes, 43 chars). */
// Last char limited to values with zero trailing bits, so each digest has one spelling.
export const Hash = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "hash");
/** 16 random bytes, base64url (22 chars). */
export const Nonce = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "nonce");

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{1,64}$`), `${prefix}… id`);

export const OfferId = id("off_");
export const MerchantId = id("mer_");
export const MerchantAgentId = id("agt_m_");
export const ConsumerAgentId = id("agt_c_");
export const MandateId = id("man_");
export const UserId = id("usr_");
export const RequestId = id("req_");

const unixSeconds = z.int().nonnegative();
const minor = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Currency = z.literal("USD");

const header = { v: z.literal(1), iat: unixSeconds, exp: unixSeconds, nonce: Nonce };

const expAfterIat = (p: { iat: number; exp: number }) => p.exp > p.iat;

export const Item = z.strictObject({
  sku: z.string().regex(/^[A-Z0-9-]{1,64}$/, "sku"),
  name: z.string().min(1).max(200),
  qty: z.int().positive().max(1000),
  unitMinor: minor,
});
export type Item = z.infer<typeof Item>;

const Items = z.array(Item).min(1).max(50);

// Partial sums only grow, so any intermediate overflow leaves the final sum unsafe.
const totalMatchesItems = (p: { items: Item[]; totalMinor: number }) => {
  const sum = p.items.reduce((acc, i) => acc + i.qty * i.unitMinor, 0);
  return Number.isSafeInteger(sum) && sum === p.totalMinor;
};

export const Offer = z
  .strictObject({
    ...header,
    type: z.literal("offer"),
    offerId: OfferId,
    merchantId: MerchantId,
    merchantAgentId: MerchantAgentId,
    paypalMerchantId: z.string().regex(/^[A-Za-z0-9]{1,64}$/, "paypalMerchantId"),
    items: Items,
    totalMinor: minor,
    currency: Currency,
    holdUntil: unixSeconds,
  })
  .refine(expAfterIat, { message: "exp must be after iat", path: ["exp"] })
  .refine(totalMatchesItems, { message: "totalMinor != sum of items", path: ["totalMinor"] });
export type Offer = z.infer<typeof Offer>;

export const IntentMandate = z
  .strictObject({
    ...header,
    type: z.literal("intent_mandate"),
    mandateId: MandateId,
    userId: UserId,
    consumerAgentId: ConsumerAgentId,
    scope: z.strictObject({
      merchants: z.array(MerchantId).min(1).max(50),
      categories: z
        .array(z.string().regex(/^[a-z0-9_-]{1,32}$/, "category"))
        .min(1)
        .max(50),
    }),
    limits: z
      .strictObject({
        perOrderMinor: minor.positive(),
        periodMinor: minor.positive(),
        period: z.enum(["day", "week", "month"]),
      })
      .refine((l) => l.perOrderMinor <= l.periodMinor, {
        message: "perOrderMinor exceeds periodMinor",
      }),
    shipToHash: Hash,
  })
  .refine(expAfterIat, { message: "exp must be after iat", path: ["exp"] });
export type IntentMandate = z.infer<typeof IntentMandate>;

export const CartApproval = z
  .strictObject({
    ...header,
    type: z.literal("cart_approval"),
    offerId: OfferId,
    offerHash: Hash,
    merchantId: MerchantId,
    items: Items,
    totalMinor: minor,
    currency: Currency,
    shipToHash: Hash,
    consumerAgentId: ConsumerAgentId,
    userId: UserId,
  })
  .refine(expAfterIat, { message: "exp must be after iat", path: ["exp"] })
  .refine((p) => p.exp - p.iat <= MAX_CART_APPROVAL_TTL_S, {
    message: `cart approval lifetime exceeds ${MAX_CART_APPROVAL_TTL_S}s`,
    path: ["exp"],
  })
  .refine(totalMatchesItems, { message: "totalMinor != sum of items", path: ["totalMinor"] });
export type CartApproval = z.infer<typeof CartApproval>;

export const WebAuthnAssertion = z.strictObject({
  credentialId: b64url,
  authenticatorData: b64url,
  clientDataJSON: b64url,
  signature: b64url,
});
export type WebAuthnAssertion = z.infer<typeof WebAuthnAssertion>;

export const signedEnvelope = <P extends z.ZodType, K extends z.ZodType<string>>(payload: P, kid: K) =>
  z.strictObject({ payload, sig: b64url, kid });

// The signing key (kid) must be the agent the offer names, or one registered
// merchant agent could sign offers claiming another merchant's identity.
export const SignedOffer = signedEnvelope(Offer, MerchantAgentId).refine((e) => e.kid === e.payload.merchantAgentId, {
  message: "kid != payload.merchantAgentId",
  path: ["kid"],
});
export type SignedOffer = z.infer<typeof SignedOffer>;

export const PasskeyAuthorization = z.strictObject({
  kind: z.literal("passkey"),
  cartApproval: CartApproval,
  assertion: WebAuthnAssertion,
});

export const MandateAuthorization = z.strictObject({
  kind: z.literal("mandate"),
  mandate: IntentMandate,
  assertion: WebAuthnAssertion,
  cart: CartApproval,
});

export const Authorization = z.discriminatedUnion("kind", [PasskeyAuthorization, MandateAuthorization]);
export type Authorization = z.infer<typeof Authorization>;

// The signing consumer agent must be the one the human approved, so a stolen
// approval cannot be re-wrapped and signed by a different registered agent.
const approvedAgents = (a: Authorization) =>
  a.kind === "passkey" ? [a.cartApproval.consumerAgentId] : [a.mandate.consumerAgentId, a.cart.consumerAgentId];

export const PaymentRequest = z
  .strictObject({
    requestId: RequestId,
    offer: SignedOffer,
    authorization: Authorization,
    agentSig: b64url,
    kid: ConsumerAgentId,
  })
  .refine((r) => approvedAgents(r.authorization).every((id) => id === r.kid), {
    message: "kid != approved consumerAgentId",
    path: ["kid"],
  })
  .refine((r) => r.authorization.kind === "passkey" || r.authorization.mandate.userId === r.authorization.cart.userId, {
    message: "mandate.userId != cart.userId",
    path: ["authorization"],
  });
export type PaymentRequest = z.infer<typeof PaymentRequest>;

/** The value `agentSig` signs: JCS({requestId, offer, authorization}) — SPEC §4.4. */
export function paymentRequestSigningInput(req: Pick<PaymentRequest, "requestId" | "offer" | "authorization">) {
  return { requestId: req.requestId, offer: req.offer, authorization: req.authorization };
}

export const OrderStatus = z.enum(["offered", "authorized", "captured", "refunded", "voided", "failed"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const Decision = z.strictObject({
  step: z.string().min(1).max(8),
  result: z.enum(["pass", "fail", "step_up", "skip"]),
  reason: z.string().max(500),
});
export type Decision = z.infer<typeof Decision>;

export const Receipt = z.strictObject({
  requestId: RequestId,
  offerHash: Hash,
  approvalHash: Hash,
  paypalOrderId: z.string().min(1).max(64),
  authorizationId: z.string().min(1).max(64),
  captureId: z.string().min(1).max(64).optional(),
  status: OrderStatus,
  decisions: z.array(Decision),
  trackingNumber: z.string().min(1).max(64).optional(),
});
export type Receipt = z.infer<typeof Receipt>;
