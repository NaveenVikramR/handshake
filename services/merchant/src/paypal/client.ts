// Minimal sandbox PayPal client for the M0 smoke test. M2 hardens it (zod-parsed responses, retries, errors).
import { toPayPalValue } from "./money.js";

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalAuthorization {
  id: string;
  status: string;
}

export interface PayPalOrder {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: { payments?: { authorizations?: PayPalAuthorization[] } }[];
  payment_source?: { paypal?: PayPalWalletSource };
}

interface PayPalWalletSource {
  email_address?: string;
  // Docs samples use both spellings; read both.
  attributes?: { vault?: PayPalVault };
  attribute?: { vault?: PayPalVault };
}

export interface PayPalVault {
  id?: string;
  status?: string;
  customer?: { id?: string };
}

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

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly debugId: string | undefined,
  ) {
    super(`PayPal API error ${status}${debugId ? ` (debug_id ${debugId})` : ""}`);
  }
}

// Error pages (e.g. an HTML 5xx) aren't JSON; keep the raw text so status and debug id survive.
function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createPayPalClient(config: PayPalConfig) {
  // Rule 1: never call live PayPal.
  if (config.baseUrl !== PAYPAL_SANDBOX_BASE_URL) {
    throw new Error(`PAYPAL_BASE_URL must be ${PAYPAL_SANDBOX_BASE_URL}`);
  }
  if (!config.clientId || !config.clientSecret) throw new Error("PayPal client id/secret missing");

  let cached: { token: string; expiresAt: number } | undefined;

  async function getToken(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = parseBody(await res.text()) as { access_token?: string; expires_in?: number } | undefined;
    if (!res.ok || !body?.access_token || !body.expires_in) {
      throw new PayPalApiError(res.status, body, res.headers.get("paypal-debug-id") ?? undefined);
    }
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return cached.token;
  }

  async function call<T>(method: "GET" | "POST", path: string, requestId?: string, body?: unknown): Promise<T> {
    if (method === "POST" && !requestId) throw new Error("PayPal-Request-Id is required on every POST");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = parseBody(await res.text());
    if (!res.ok) throw new PayPalApiError(res.status, parsed, res.headers.get("paypal-debug-id") ?? undefined);
    return parsed as T;
  }

  return {
    getToken,

    createOrderAuthorize(input: CreateOrderInput): Promise<PayPalOrder> {
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
      return call<PayPalOrder>("POST", "/v2/checkout/orders", input.requestId, {
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

    getOrder(orderId: string): Promise<PayPalOrder> {
      return call<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    },

    authorizeOrder(orderId: string, requestId: string): Promise<PayPalOrder> {
      return call<PayPalOrder>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, requestId, {});
    },

    voidAuthorization(authorizationId: string, requestId: string): Promise<PayPalAuthorization> {
      return call<PayPalAuthorization>(
        "POST",
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
        requestId,
      );
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
