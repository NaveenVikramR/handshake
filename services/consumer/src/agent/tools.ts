// The planner's tools (SPEC §5.2, §8). Arguments are zod-validated and strict: no tool takes an
// amount, payee, address or approval, and money moves only via `checkout({ offerId })` (rules/llm.md).
// Signed offers stay in the session; the LLM sees a summary with merchant text marked untrusted.
import {
  HandshakeError,
  hash,
  isHandshakeError,
  randomNonce,
  signEnvelope,
  type OfferRequest,
  type Receipt,
  type SignedOffer,
} from "@handshake/core";
import { z } from "zod";
import type { AgentConfig, AppContext } from "../context.js";
import { authorize, type CheckoutEvent } from "./checkout.js";
import { merchantClient, type MerchantClient } from "./merchant.js";
import type { ToolSpec } from "./planner.js";
import { trustedMerchant, verifyOfferWithRegistry } from "./trust.js";

const OFFER_REQUEST_TTL_S = 60;

/** Merchant-supplied text as delimited data the model must not obey. Delimiters inside are removed. */
export const untrusted = (s: string) =>
  `<untrusted>${s.replace(/<\/?untrusted>/gi, "").replace(/[<>]/g, "")}</untrusted>`;

export type AgentEvent =
  | CheckoutEvent
  | { type: "tool"; name: string; ids: Record<string, string> }
  | { type: "tool_result"; name: string; ok: boolean; error?: string }
  | { type: "receipt"; receipt: Receipt; offerId: string; totalMinor: number; currency: string }
  | { type: "message"; text: string }
  | { type: "error"; error: string };

export interface ChatSession {
  userId: string;
  shipToHash: string | undefined;
  merchants: Map<string, { client: MerchantClient; name: string }>;
  offers: Map<string, { offer: SignedOffer; merchantId: string }>;
  paid: Set<string>;
  /** Mandate-path checkouts so far; after one, further checkouts in this chat need the phone. */
  mandateCheckouts: number;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

const MerchantId = z.string().regex(/^mer_[A-Za-z0-9_-]{1,64}$/);
const OfferId = z.string().regex(/^off_[A-Za-z0-9_-]{1,64}$/);

const Args = {
  discover_merchants: z.strictObject({}),
  get_catalog: z.strictObject({ merchantId: MerchantId }),
  request_offer: z.strictObject({
    merchantId: MerchantId,
    items: z
      .array(z.strictObject({ sku: z.string().regex(/^[A-Z0-9-]{1,64}$/), qty: z.int().min(1).max(10) }))
      .min(1)
      .max(20),
  }),
  verify_offer: z.strictObject({ offerId: OfferId }),
  checkout: z.strictObject({ offerId: OfferId }),
};
export type ToolName = keyof typeof Args;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "discover_merchants",
    description: "List the merchants you may buy from (registry-checked).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_catalog",
    description: "A merchant's products: sku, name, category, price in minor units, in stock.",
    parameters: {
      type: "object",
      properties: { merchantId: { type: "string" } },
      required: ["merchantId"],
      additionalProperties: false,
    },
  },
  {
    name: "request_offer",
    description: "Ask a merchant for a signed offer for skus and quantities. The merchant sets the prices.",
    parameters: {
      type: "object",
      properties: {
        merchantId: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "integer", minimum: 1, maximum: 10 } },
            required: ["sku", "qty"],
            additionalProperties: false,
          },
        },
      },
      required: ["merchantId", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_offer",
    description: "Check an offer's signature and merchant identity against the trust registry.",
    parameters: {
      type: "object",
      properties: { offerId: { type: "string" } },
      required: ["offerId"],
      additionalProperties: false,
    },
  },
  {
    name: "checkout",
    description:
      "Pay for a verified offer. Code decides mandate vs phone approval and may wait for the person to approve.",
    parameters: {
      type: "object",
      properties: { offerId: { type: "string" } },
      required: ["offerId"],
      additionalProperties: false,
    },
  },
];

function merchantOf(s: ChatSession, merchantId: string) {
  const m = s.merchants.get(merchantId);
  if (!m) throw new HandshakeError("MERCHANT_UNTRUSTED", "call discover_merchants first; unknown merchant");
  return m;
}

function offerOf(s: ChatSession, offerId: string) {
  const o = s.offers.get(offerId);
  if (!o) throw new HandshakeError("OFFER_SIG_INVALID", "unknown offer in this chat");
  return o;
}

const summary = (o: SignedOffer) => ({
  offerId: o.payload.offerId,
  merchantId: o.payload.merchantId,
  items: o.payload.items.map((i) => ({ sku: i.sku, name: untrusted(i.name), qty: i.qty, unitMinor: i.unitMinor })),
  totalMinor: o.payload.totalMinor,
  currency: o.payload.currency,
  holdUntil: o.payload.holdUntil,
});

async function run(ctx: AppContext, agent: AgentConfig, s: ChatSession, name: ToolName, args: unknown) {
  const nowS = () => Math.floor(ctx.now() / 1000);
  switch (name) {
    case "discover_merchants": {
      Args.discover_merchants.parse(args);
      const found = [];
      for (const url of agent.merchantUrls) {
        const client = merchantClient(url, agent.fetch);
        try {
          const card = await client.card();
          const merchant = await trustedMerchant(ctx.store, card.merchantAgentId);
          // The card only points at a registry entry; if it disagrees with the registry, skip it.
          if (merchant.id !== card.merchantId) continue;
          s.merchants.set(merchant.id, { client, name: merchant.name });
          found.push({ merchantId: merchant.id, name: untrusted(merchant.name) });
        } catch (e) {
          if (!isHandshakeError(e)) throw e;
        }
      }
      return { merchants: found };
    }
    case "get_catalog": {
      const { merchantId } = Args.get_catalog.parse(args);
      const catalog = await merchantOf(s, merchantId).client.catalog();
      if (catalog.merchantId !== merchantId)
        throw new HandshakeError("MERCHANT_UNTRUSTED", "catalog for another merchant");
      return {
        merchantId,
        products: catalog.products.map((p) => ({
          sku: p.sku,
          name: untrusted(p.name),
          category: untrusted(p.category),
          priceMinor: p.priceMinor,
          inStock: p.inStock,
        })),
      };
    }
    case "request_offer": {
      const { merchantId, items } = Args.request_offer.parse(args);
      const m = merchantOf(s, merchantId);
      const iat = nowS();
      const payload: OfferRequest = {
        v: 1,
        type: "offer_request",
        consumerAgentId: ctx.consumerAgentId,
        merchantId,
        items,
        iat,
        exp: iat + OFFER_REQUEST_TTL_S,
        nonce: randomNonce(),
      };
      const offer = await m.client.requestOffer(signEnvelope(payload, agent.privateKey, ctx.consumerAgentId));
      const merchant = await verifyOfferWithRegistry(ctx.store, offer, nowS());
      if (merchant.id !== merchantId) throw new HandshakeError("MERCHANT_UNTRUSTED", "offer from another merchant");
      s.offers.set(offer.payload.offerId, { offer, merchantId });
      return summary(offer);
    }
    case "verify_offer": {
      const { offerId } = Args.verify_offer.parse(args);
      const merchant = await verifyOfferWithRegistry(ctx.store, offerOf(s, offerId).offer, nowS());
      return { offerId, verified: true, merchant: untrusted(merchant.name) };
    }
    case "checkout": {
      const { offerId } = Args.checkout.parse(args);
      if (s.paid.has(offerId)) throw new HandshakeError("OFFER_USED", "already checked out");
      const { offer, merchantId } = offerOf(s, offerId);
      // Re-verify: the summary the LLM saw is irrelevant, only the signed offer counts.
      await verifyOfferWithRegistry(ctx.store, offer, nowS());
      const m = merchantOf(s, merchantId);
      const catalog = await m.client.catalog();
      const category = new Map(catalog.products.map((p) => [p.sku, p.category]));
      s.paid.add(offerId);
      const { request, decision } = await authorize(ctx, agent, {
        userId: s.userId,
        offer,
        categories: offer.payload.items.map((i) => category.get(i.sku) ?? ""),
        shipToHash: s.shipToHash,
        // One unattended purchase per chat: a looping model or an injection can't repeat orders silently.
        forceStepUp: s.mandateCheckouts > 0 ? "one mandate checkout per chat already made" : undefined,
        emit: s.emit,
        ...(s.signal ? { signal: s.signal } : {}),
      });
      if (decision.path === "mandate") s.mandateCheckouts++;
      const receipt = await m.client.pay(request);
      if (receipt.requestId !== request.requestId || receipt.offerHash !== hash(offer.payload)) {
        throw new HandshakeError("MERCHANT_UNTRUSTED", "receipt does not match the payment request");
      }
      s.emit({
        type: "receipt",
        receipt,
        offerId,
        totalMinor: offer.payload.totalMinor,
        currency: offer.payload.currency,
      });
      return {
        offerId,
        requestId: receipt.requestId,
        status: receipt.status,
        totalMinor: offer.payload.totalMinor,
        currency: offer.payload.currency,
      };
    }
  }
}

/** Runs one tool call. Bad arguments and verification failures become `{ error }` for the model. */
export async function runTool(
  ctx: AppContext,
  agent: AgentConfig,
  s: ChatSession,
  name: string,
  rawArgs: string,
): Promise<unknown> {
  if (!Object.hasOwn(Args, name)) return { error: "UNKNOWN_TOOL" };
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return { error: "SCHEMA_INVALID" };
  }
  try {
    const out = await run(ctx, agent, s, name as ToolName, args);
    s.emit({ type: "tool_result", name, ok: true });
    return out;
  } catch (e) {
    const code = isHandshakeError(e) ? e.code : e instanceof z.ZodError ? "SCHEMA_INVALID" : undefined;
    if (!code) throw e;
    s.emit({ type: "tool_result", name, ok: false, error: code });
    return { error: code };
  }
}
