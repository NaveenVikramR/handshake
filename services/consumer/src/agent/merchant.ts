// HTTP client for a merchant agent (SPEC §10). Responses are parsed; nothing in them is trusted
// until checked against the registry (offers) or wrapped as untrusted text (names).
import {
  ERROR_CODES,
  HandshakeError,
  Item,
  Receipt,
  SignedOffer,
  isHandshakeError,
  type ErrorCode,
  type PaymentRequest,
  type SignedOfferRequest,
} from "@handshake/core";
import { z } from "zod";

const TIMEOUT_MS = 15_000;

export const AgentCard = z.object({
  merchantId: z.string(),
  merchantAgentId: z.string(),
  name: z.string().max(200),
});
export type AgentCard = z.infer<typeof AgentCard>;

export const Catalog = z.object({
  merchantId: z.string(),
  products: z
    .array(
      z.object({
        // Shape-checked so only names and categories (wrapped as untrusted) carry free text.
        sku: Item.shape.sku,
        name: z.string().max(200),
        category: z.string().max(32),
        priceMinor: z.int().nonnegative(),
        currency: z.literal("USD"),
        inStock: z.boolean(),
      }),
    )
    .max(500),
});
export type Catalog = z.infer<typeof Catalog>;

const OfferResponse = z.object({ offer: SignedOffer });
const ErrorResponse = z.object({ error: z.string() });

export interface MerchantClient {
  baseUrl: string;
  card(): Promise<AgentCard>;
  catalog(): Promise<Catalog>;
  requestOffer(req: SignedOfferRequest): Promise<SignedOffer>;
  pay(req: PaymentRequest): Promise<Receipt>;
}

/** A merchant error code we pass on (e.g. OUT_OF_STOCK); anything unknown becomes MERCHANT_UNTRUSTED. */
function merchantError(status: number, body: unknown): HandshakeError {
  const parsed = ErrorResponse.safeParse(body);
  const code = parsed.success ? parsed.data.error : undefined;
  if (code && (ERROR_CODES as readonly string[]).includes(code)) {
    return new HandshakeError(code as ErrorCode, `merchant returned ${status} ${code}`);
  }
  return new HandshakeError("MERCHANT_UNTRUSTED", `merchant returned ${status}`);
}

export function merchantClient(baseUrl: string, doFetch: typeof fetch = fetch): MerchantClient {
  const origin = new URL(baseUrl).origin;

  async function call<T>(schema: z.ZodType<T>, path: string, body?: unknown): Promise<T> {
    let res: Response;
    let parsed: unknown;
    try {
      res = await doFetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      parsed = JSON.parse(await res.text());
    } catch (e) {
      if (isHandshakeError(e)) throw e;
      throw new HandshakeError("MERCHANT_UNTRUSTED", "merchant unreachable or sent invalid JSON");
    }
    if (!res.ok) throw merchantError(res.status, parsed);
    const ok = schema.safeParse(parsed);
    if (!ok.success) throw new HandshakeError("MERCHANT_UNTRUSTED", `unexpected response from ${path}`);
    return ok.data;
  }

  return {
    baseUrl: origin,
    card: () => call(AgentCard, "/.well-known/agent.json"),
    catalog: () => call(Catalog, "/catalog"),
    requestOffer: async (req) => (await call(OfferResponse, "/offers", req)).offer,
    pay: (req) => call(Receipt, "/payments", req),
  };
}
