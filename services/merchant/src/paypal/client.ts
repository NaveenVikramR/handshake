// Sandbox PayPal REST client. The only code that talks to PayPal (rules/payments.md).
// Facts and doc links: docs/PAYPAL.md.
import { randomUUID } from "node:crypto";
import { HandshakeError } from "@handshake/core";
import { z } from "zod";
import { toPayPalValue } from "./money.js";

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_EARLY_REFRESH_S = 60;

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds since epoch; injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Responses keep only the fields we use; everything else is stripped.
const Link = z.object({ href: z.string(), rel: z.string(), method: z.string().optional() });
const Authorization = z.object({ id: z.string().min(1), status: z.string() });
const Capture = z.object({ id: z.string().min(1), status: z.string() });
const Vault = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  customer: z.object({ id: z.string().optional() }).optional(),
});
const Order = z.object({
  id: z.string().min(1),
  status: z.string(),
  links: z.array(Link).optional(),
  purchase_units: z
    .array(
      z.object({
        payments: z
          .object({ authorizations: z.array(Authorization).optional(), captures: z.array(Capture).optional() })
          .optional(),
      }),
    )
    .optional(),
  payment_source: z
    .object({
      paypal: z
        .object({
          // Docs samples use both spellings; read both.
          attributes: z.object({ vault: Vault.optional() }).optional(),
          attribute: z.object({ vault: Vault.optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
const Refund = z.object({ id: z.string().min(1), status: z.string() });
const Tracked = z.object({ id: z.string().min(1), status: z.string() });
const Token = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });
const VerifyResult = z.object({ verification_status: z.string() });
const Webhook = z.object({
  id: z.string().min(1),
  url: z.string(),
  event_types: z.array(z.object({ name: z.string() })).optional(),
});
const WebhookList = z.object({ webhooks: z.array(Webhook).optional() });
const ErrorBody = z.object({
  name: z.string().optional(),
  details: z.array(z.object({ issue: z.string().optional() })).optional(),
});

export type PayPalOrder = z.infer<typeof Order>;
export type PayPalAuthorization = z.infer<typeof Authorization>;
export type PayPalCapture = z.infer<typeof Capture>;
export type PayPalRefund = z.infer<typeof Refund>;
export type PayPalVault = z.infer<typeof Vault>;
export type PayPalWebhook = z.infer<typeof Webhook>;

export interface CreateOrderInput {
  requestId: string;
  invoiceId: string;
  totalMinor: number;
  currency: "USD";
  returnUrl: string;
  cancelUrl: string;
  /** First order: ask PayPal to save the wallet for later merchant-initiated payments. */
  saveWallet?: boolean;
  /** Later orders: pay with a saved wallet instead of a buyer redirect. */
  vaultId?: string;
  /** Spike fallback if a vault_id order still asks for approval. */
  merchantInitiated?: boolean;
}

export interface TrackingInput {
  captureId: string;
  trackingNumber: string;
  /** PayPal carrier enum value; use "OTHER" with carrierNameOther for anything else. */
  carrier: string;
  carrierNameOther?: string;
  notifyPayer?: boolean;
}

export interface WebhookVerifyInput {
  /** Request headers as Node exposes them (lower-case names). */
  headers: Record<string, string | string[] | undefined>;
  /** The request body exactly as received. */
  rawBody: string;
  webhookId: string;
}

/**
 * A PayPal call failed. Carries what we may log: status, PayPal issue, debug id. Never the token.
 * `maybeApplied`: a POST that timed out, lost its connection or got a 5xx may still have taken
 * effect at PayPal. Callers must retry it with the SAME PayPal-Request-Id (stored per order and
 * operation) and must not void or mark failed on this error alone.
 */
export class PayPalApiError extends HandshakeError {
  constructor(
    readonly httpStatus: number,
    readonly issue: string | undefined,
    readonly debugId: string | undefined,
    readonly maybeApplied = false,
  ) {
    super(
      "PAYPAL_ERROR",
      `PayPal API error ${httpStatus}${issue ? ` ${issue}` : ""}${debugId ? ` (debug_id ${debugId})` : ""}`,
    );
  }
}

// Error pages (e.g. an HTML 5xx) aren't JSON; keep undefined so status and debug id survive.
function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function issueOf(body: unknown): string | undefined {
  const parsed = ErrorBody.safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data.details?.find((d) => d.issue)?.issue ?? parsed.data.name;
}

const retryable = (status: number) => status === 429 || status >= 500;

const seg = (id: string) => encodeURIComponent(id);

export function createPayPalClient(config: PayPalConfig) {
  // Rule 1: never call live PayPal.
  if (config.baseUrl !== PAYPAL_SANDBOX_BASE_URL) {
    throw new Error(`PAYPAL_BASE_URL must be ${PAYPAL_SANDBOX_BASE_URL}`);
  }
  if (!config.clientId || !config.clientSecret) throw new Error("PayPal client id/secret missing");

  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * fetch + body read under one timeout. Any network failure, including a stalled
   * or reset body after headers arrived, becomes PayPalApiError (status 0).
   */
  async function send(url: string, init: RequestInit): Promise<{ res: Response; text: string }> {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return { res, text: await res.text() };
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      throw new PayPalApiError(0, timedOut ? "TIMEOUT" : "NETWORK_ERROR", undefined, init.method === "POST");
    }
  }

  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const { res, text } = await send(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "PayPal-Request-Id": randomUUID(),
      },
      body: "grant_type=client_credentials",
    });
    const body = parseJson(text);
    const parsed = Token.safeParse(body);
    if (!res.ok || !parsed.success) {
      throw new PayPalApiError(res.status, issueOf(body), res.headers.get("paypal-debug-id") ?? undefined);
    }
    const ttl = Math.max(parsed.data.expires_in - TOKEN_EARLY_REFRESH_S, 0);
    cached = { token: parsed.data.access_token, expiresAt: now() + ttl * 1000 };
    return cached.token;
  }

  /** Cached until expires_in − 60 s; concurrent callers share one token request. */
  async function getToken(): Promise<string> {
    if (cached && now() < cached.expiresAt) return cached.token;
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  async function call<T>(
    schema: z.ZodType<T>,
    method: "GET" | "POST",
    path: string,
    requestId?: string,
    body?: unknown,
  ): Promise<T> {
    if (method === "POST" && !requestId) throw new Error("PayPal-Request-Id is required on every POST");
    const payload = typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body);
    let refreshedToken = false;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await getToken()}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      };
      // Retries resend the same id, so PayPal returns the original result instead of acting twice.
      if (requestId) headers["PayPal-Request-Id"] = requestId;

      const { res, text } = await send(`${config.baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
      const parsed = parseJson(text);
      const debugId = res.headers.get("paypal-debug-id") ?? undefined;

      if (res.status === 401 && !refreshedToken) {
        // Token revoked or expired early: fetch a fresh one once.
        cached = undefined;
        refreshedToken = true;
        attempt--;
        continue;
      }
      if (retryable(res.status) && attempt < MAX_RETRIES) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        throw new PayPalApiError(res.status, issueOf(parsed), debugId, method === "POST" && res.status >= 500);
      }

      const result = schema.safeParse(parsed);
      // A 2xx POST already took effect even if we can't read the reply.
      if (!result.success) throw new PayPalApiError(res.status, "UNEXPECTED_RESPONSE", debugId, method === "POST");
      return result.data;
    }
  }

  return {
    getToken,

    async createOrderAuthorize(input: CreateOrderInput): Promise<PayPalOrder> {
      const paypal: Record<string, unknown> = {};
      if (input.vaultId) {
        paypal.vault_id = input.vaultId;
        if (input.merchantInitiated) {
          paypal.stored_credential = { payment_initiator: "MERCHANT", usage: "SUBSEQUENT" };
        }
      } else {
        paypal.experience_context = {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          user_action: "CONTINUE",
          shipping_preference: "NO_SHIPPING",
        };
        if (input.saveWallet) {
          paypal.attributes = {
            vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" },
          };
        }
      }
      return call(Order, "POST", "/v2/checkout/orders", input.requestId, {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            amount: { currency_code: input.currency, value: toPayPalValue(input.totalMinor) },
            custom_id: input.requestId,
            invoice_id: input.invoiceId,
          },
        ],
        payment_source: { paypal },
      });
    },

    async getOrder(orderId: string): Promise<PayPalOrder> {
      return call(Order, "GET", `/v2/checkout/orders/${seg(orderId)}`);
    },

    async authorizeOrder(orderId: string, requestId: string): Promise<PayPalOrder> {
      return call(Order, "POST", `/v2/checkout/orders/${seg(orderId)}/authorize`, requestId, {});
    },

    /** Captures the full authorized amount and closes the authorization. */
    async captureAuthorization(
      authorizationId: string,
      requestId: string,
      opts: { invoiceId?: string } = {},
    ): Promise<PayPalCapture> {
      return call(Capture, "POST", `/v2/payments/authorizations/${seg(authorizationId)}/capture`, requestId, {
        final_capture: true,
        ...(opts.invoiceId ? { invoice_id: opts.invoiceId } : {}),
      });
    },

    async voidAuthorization(authorizationId: string, requestId: string): Promise<PayPalAuthorization> {
      // No body: the form confirmed in the M0 sandbox smoke.
      return call(Authorization, "POST", `/v2/payments/authorizations/${seg(authorizationId)}/void`, requestId);
    },

    /** Full refund unless amountMinor is given. */
    async refundCapture(
      captureId: string,
      requestId: string,
      opts: { amountMinor?: number; currency?: "USD" } = {},
    ): Promise<PayPalRefund> {
      const body =
        opts.amountMinor === undefined
          ? {}
          : { amount: { currency_code: opts.currency ?? "USD", value: toPayPalValue(opts.amountMinor) } };
      return call(Refund, "POST", `/v2/payments/captures/${seg(captureId)}/refund`, requestId, body);
    },

    async addTracking(orderId: string, requestId: string, input: TrackingInput): Promise<z.infer<typeof Tracked>> {
      if (input.carrier === "OTHER" && !input.carrierNameOther) {
        throw new Error("carrierNameOther is required when carrier is OTHER");
      }
      return call(Tracked, "POST", `/v2/checkout/orders/${seg(orderId)}/track`, requestId, {
        capture_id: input.captureId,
        tracking_number: input.trackingNumber,
        carrier: input.carrier,
        ...(input.carrierNameOther ? { carrier_name_other: input.carrierNameOther } : {}),
        notify_payer: input.notifyPayer ?? false,
      });
    },

    /** Webhooks registered for this REST app. */
    async listWebhooks(): Promise<PayPalWebhook[]> {
      return (await call(WebhookList, "GET", "/v1/notifications/webhooks")).webhooks ?? [];
    },

    /** Subscribes `url` to `eventTypes`. Setup only (scripts/paypal-webhook-create.ts). */
    async createWebhook(url: string, eventTypes: string[], requestId: string): Promise<PayPalWebhook> {
      return call(Webhook, "POST", "/v1/notifications/webhooks", requestId, {
        url,
        event_types: eventTypes.map((name) => ({ name })),
      });
    },

    /**
     * Asks PayPal whether a webhook delivery is genuine. Fails closed: missing
     * headers, a body that isn't a JSON object, or anything but SUCCESS → false.
     * The event is spliced in as the raw received text; re-serialising it can
     * change bytes and fail verification.
     */
    async verifyWebhook({ headers, rawBody, webhookId }: WebhookVerifyInput): Promise<boolean> {
      const h = (name: string) => {
        const v = headers[name];
        return typeof v === "string" && v.length > 0 ? v : undefined;
      };
      const fields = {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
      };
      if (!webhookId || Object.values(fields).some((v) => v === undefined)) return false;
      const event = parseJson(rawBody);
      if (typeof event !== "object" || event === null || Array.isArray(event)) return false;

      const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
      const result = await call(VerifyResult, "POST", "/v1/notifications/verify-webhook-signature", randomUUID(), body);
      return result.verification_status === "SUCCESS";
    },
  };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;

export function approvalLink(order: PayPalOrder): string | undefined {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}

export function firstAuthorization(order: PayPalOrder): PayPalAuthorization | undefined {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0];
}

export function savedWallet(order: PayPalOrder): PayPalVault | undefined {
  const source = order.payment_source?.paypal;
  return source?.attributes?.vault ?? source?.attribute?.vault;
}
