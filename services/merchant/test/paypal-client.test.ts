import { HandshakeError } from "@handshake/core";
import { describe, expect, it } from "vitest";
import { PAYPAL_SANDBOX_BASE_URL, PayPalApiError, createPayPalClient } from "../src/paypal/client.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

const TOKEN: Reply = { status: 200, body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } };

/** fetch mock: replies in order; records every request. */
function mockFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const r = queue.shift();
    if (!r) throw new Error(`unexpected request ${String(input)}`);
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text || null, { status: r.status, headers: r.headers ?? {} });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, pending: () => queue.length };
}

function client(replies: Reply[], clock = { t: 1_000_000 }) {
  const m = mockFetch(replies);
  const sleeps: number[] = [];
  const paypal = createPayPalClient({
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    clientId: "cid",
    clientSecret: "secret",
    fetch: m.fetch,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { paypal, ...m, sleeps, clock };
}

const order = (extra: object = {}) => ({ id: "ORDER-1", status: "CREATED", ...extra });
const apiCalls = (calls: Call[]) => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token"));

describe("config guard", () => {
  it.each([
    "https://api-m.paypal.com",
    "https://api-m.sandbox.paypal.com.evil.com",
    "http://api-m.sandbox.paypal.com",
    "",
  ])("refuses base URL %j", (baseUrl) => {
    expect(() => createPayPalClient({ baseUrl, clientId: "a", clientSecret: "b" })).toThrow(/PAYPAL_BASE_URL/);
  });

  it("refuses missing credentials", () => {
    expect(() => createPayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: "", clientSecret: "b" })).toThrow();
  });
});

describe("token cache", () => {
  it("fetches with Basic auth and form body, then reuses the token", async () => {
    const { paypal, calls } = client([TOKEN]);
    expect(await paypal.getToken()).toBe("tok-1");
    expect(await paypal.getToken()).toBe("tok-1");
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`);
    expect(c.headers.Authorization).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    expect(c.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(c.headers["PayPal-Request-Id"]).toBeTruthy();
    expect(c.body).toBe("grant_type=client_credentials");
  });

  it("refreshes 60 s before expires_in", async () => {
    const { paypal, calls, clock } = client([TOKEN, { ...TOKEN, body: { access_token: "tok-2", expires_in: 3600 } }]);
    await paypal.getToken();
    clock.t += (3600 - 60) * 1000 - 1;
    expect(await paypal.getToken()).toBe("tok-1");
    clock.t += 1;
    expect(await paypal.getToken()).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("shares one token request between concurrent callers", async () => {
    const { paypal, calls } = client([TOKEN]);
    const tokens = await Promise.all([paypal.getToken(), paypal.getToken(), paypal.getToken()]);
    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(calls).toHaveLength(1);
  });

  it("throws PAYPAL_ERROR on auth failure without leaking the secret", async () => {
    const { paypal } = client([
      { status: 401, body: { error: "invalid_client" }, headers: { "paypal-debug-id": "dbg1" } },
    ]);
    const err = await paypal.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toBeInstanceOf(HandshakeError);
    expect((err as PayPalApiError).code).toBe("PAYPAL_ERROR");
    expect((err as PayPalApiError).debugId).toBe("dbg1");
    expect(JSON.stringify(err) + (err as Error).message).not.toContain("secret");
  });

  it("refetches the token once on a 401 from an API call", async () => {
    const { paypal, calls } = client([
      TOKEN,
      { status: 401, body: { name: "AUTHENTICATION_FAILURE" } },
      { ...TOKEN, body: { access_token: "tok-2", expires_in: 3600 } },
      { status: 200, body: order() },
    ]);
    await paypal.getOrder("ORDER-1");
    const api = apiCalls(calls);
    expect(api).toHaveLength(2);
    expect(api[1]!.headers.Authorization).toBe("Bearer tok-2");
  });

  it("gives up after a second 401", async () => {
    const { paypal } = client([TOKEN, { status: 401 }, TOKEN, { status: 401 }]);
    await expect(paypal.getOrder("ORDER-1")).rejects.toMatchObject({ code: "PAYPAL_ERROR", httpStatus: 401 });
  });
});

describe("createOrderAuthorize", () => {
  const input = {
    requestId: "req_abc",
    invoiceId: "ord_1",
    totalMinor: 1348,
    currency: "USD" as const,
    returnUrl: "https://example.com/r",
    cancelUrl: "https://example.com/c",
  };

  it("sends AUTHORIZE with a decimal-string amount and our requestId as PayPal-Request-Id", async () => {
    const { paypal, calls } = client([TOKEN, { status: 201, body: order() }]);
    const res = await paypal.createOrderAuthorize(input);
    expect(res).toEqual({ id: "ORDER-1", status: "CREATED" });
    const c = apiCalls(calls)[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders`);
    expect(c.headers["PayPal-Request-Id"]).toBe("req_abc");
    expect(c.headers.Authorization).toBe("Bearer tok-1");
    const body = JSON.parse(c.body!);
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units[0]).toEqual({
      amount: { currency_code: "USD", value: "13.48" },
      custom_id: "req_abc",
      invoice_id: "ord_1",
    });
  });

  it("uses vault_id with no redirect context for saved wallets", async () => {
    const { paypal, calls } = client([TOKEN, { status: 201, body: order({ status: "COMPLETED" }) }]);
    await paypal.createOrderAuthorize({ ...input, vaultId: "VAULT-1" });
    const body = JSON.parse(apiCalls(calls)[0]!.body!);
    expect(body.payment_source.paypal).toEqual({ vault_id: "VAULT-1" });
  });

  it.each([0, -1, 4.99, Number.NaN])("refuses amount %s before calling PayPal", async (totalMinor) => {
    const { paypal, calls } = client([TOKEN]);
    await expect(paypal.createOrderAuthorize({ ...input, totalMinor })).rejects.toThrow();
    expect(apiCalls(calls)).toHaveLength(0);
  });

  it("strips fields we don't use from the response", async () => {
    const { paypal } = client([TOKEN, { status: 201, body: order({ payer: { email_address: "x@y" }, extra: 1 }) }]);
    expect(await paypal.createOrderAuthorize(input)).toEqual({ id: "ORDER-1", status: "CREATED" });
  });
});

describe("payments calls", () => {
  it("captureAuthorization: final capture of the full amount with PayPal-Request-Id", async () => {
    const { paypal, calls } = client([TOKEN, { status: 201, body: { id: "CAP-1", status: "COMPLETED", amount: {} } }]);
    expect(await paypal.captureAuthorization("AUTH-1", "req_cap")).toEqual({ id: "CAP-1", status: "COMPLETED" });
    const c = apiCalls(calls)[0]!;
    expect(c.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/payments/authorizations/AUTH-1/capture`);
    expect(c.headers["PayPal-Request-Id"]).toBe("req_cap");
    expect(JSON.parse(c.body!)).toEqual({ final_capture: true });
  });

  it("voidAuthorization: POST without a body", async () => {
    const { paypal, calls } = client([TOKEN, { status: 200, body: { id: "AUTH-1", status: "VOIDED" } }]);
    expect(await paypal.voidAuthorization("AUTH-1", "req_void")).toEqual({ id: "AUTH-1", status: "VOIDED" });
    const c = apiCalls(calls)[0]!;
    expect(c.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/payments/authorizations/AUTH-1/void`);
    expect(c.headers["PayPal-Request-Id"]).toBe("req_void");
    expect(c.body).toBeUndefined();
  });

  it("refundCapture: empty body is a full refund; partial sends a decimal string", async () => {
    const { paypal, calls } = client([
      TOKEN,
      { status: 201, body: { id: "REF-1", status: "COMPLETED" } },
      { status: 201, body: { id: "REF-2", status: "COMPLETED" } },
    ]);
    await paypal.refundCapture("CAP-1", "req_r1");
    await paypal.refundCapture("CAP-1", "req_r2", { amountMinor: 250 });
    const [full, partial] = apiCalls(calls);
    expect(full!.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/payments/captures/CAP-1/refund`);
    expect(JSON.parse(full!.body!)).toEqual({});
    expect(JSON.parse(partial!.body!)).toEqual({ amount: { currency_code: "USD", value: "2.50" } });
    expect(partial!.headers["PayPal-Request-Id"]).toBe("req_r2");
  });

  it("addTracking: capture_id, tracking_number, carrier OTHER + carrier_name_other", async () => {
    const { paypal, calls } = client([TOKEN, { status: 201, body: { id: "ORDER-1", status: "COMPLETED" } }]);
    await paypal.addTracking("ORDER-1", "req_t", {
      captureId: "CAP-1",
      trackingNumber: "TRK1",
      carrier: "OTHER",
      carrierNameOther: "Local courier",
    });
    const c = apiCalls(calls)[0]!;
    expect(c.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders/ORDER-1/track`);
    expect(c.headers["PayPal-Request-Id"]).toBe("req_t");
    expect(JSON.parse(c.body!)).toEqual({
      capture_id: "CAP-1",
      tracking_number: "TRK1",
      carrier: "OTHER",
      carrier_name_other: "Local courier",
      notify_payer: false,
    });
  });

  it("addTracking: OTHER without a carrier name is refused locally", async () => {
    const { paypal, calls } = client([TOKEN]);
    await expect(
      paypal.addTracking("ORDER-1", "req_t", { captureId: "CAP-1", trackingNumber: "T", carrier: "OTHER" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("encodes ids in paths", async () => {
    const { paypal, calls } = client([TOKEN, { status: 200, body: { id: "x", status: "VOIDED" } }]);
    await paypal.voidAuthorization("../../v1/oauth2/token", "req_v");
    expect(apiCalls(calls)[0]!.url).toBe(
      `${PAYPAL_SANDBOX_BASE_URL}/v2/payments/authorizations/..%2F..%2Fv1%2Foauth2%2Ftoken/void`,
    );
  });

  it("every POST carries PayPal-Request-Id", async () => {
    const { paypal, calls } = client([
      TOKEN,
      { status: 201, body: order() },
      { status: 201, body: order() },
      { status: 201, body: { id: "CAP-1", status: "COMPLETED" } },
      { status: 200, body: { id: "AUTH-1", status: "VOIDED" } },
      { status: 201, body: { id: "REF-1", status: "COMPLETED" } },
      { status: 201, body: { id: "ORDER-1", status: "COMPLETED" } },
    ]);
    await paypal.createOrderAuthorize({
      requestId: "r1",
      invoiceId: "i",
      totalMinor: 1,
      currency: "USD",
      returnUrl: "u",
      cancelUrl: "u",
    });
    await paypal.authorizeOrder("ORDER-1", "r2");
    await paypal.captureAuthorization("AUTH-1", "r3");
    await paypal.voidAuthorization("AUTH-1", "r4");
    await paypal.refundCapture("CAP-1", "r5");
    await paypal.addTracking("ORDER-1", "r6", { captureId: "CAP-1", trackingNumber: "T", carrier: "UPS" });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(7);
    for (const p of posts) expect(p.headers["PayPal-Request-Id"]).toBeTruthy();
  });
});

describe("errors and retries", () => {
  it("maps details[].issue into PAYPAL_ERROR", async () => {
    const { paypal } = client([
      TOKEN,
      {
        status: 422,
        body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUSLY_CAPTURED" }] },
        headers: { "paypal-debug-id": "dbg9" },
      },
    ]);
    const err = (await paypal.voidAuthorization("AUTH-1", "r").catch((e: unknown) => e)) as PayPalApiError;
    expect(err.code).toBe("PAYPAL_ERROR");
    expect(err.httpStatus).toBe(422);
    expect(err.issue).toBe("PREVIOUSLY_CAPTURED");
    expect(err.debugId).toBe("dbg9");
  });

  it("does not retry 4xx", async () => {
    const { paypal, calls } = client([TOKEN, { status: 400, body: { name: "INVALID_REQUEST" } }]);
    await expect(paypal.captureAuthorization("AUTH-1", "r")).rejects.toMatchObject({ issue: "INVALID_REQUEST" });
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it("retries 5xx and 429 at most twice with the same PayPal-Request-Id", async () => {
    const { paypal, calls, sleeps } = client([
      TOKEN,
      { status: 503, body: "<html>down</html>" },
      { status: 429 },
      { status: 201, body: { id: "CAP-1", status: "COMPLETED" } },
    ]);
    expect((await paypal.captureAuthorization("AUTH-1", "req_same")).id).toBe("CAP-1");
    const api = apiCalls(calls);
    expect(api).toHaveLength(3);
    expect(new Set(api.map((c) => c.headers["PayPal-Request-Id"]))).toEqual(new Set(["req_same"]));
    expect(sleeps).toHaveLength(2);
  });

  it("stops after two retries", async () => {
    const { paypal, calls } = client([TOKEN, { status: 500 }, { status: 502 }, { status: 503 }]);
    await expect(paypal.captureAuthorization("AUTH-1", "r")).rejects.toMatchObject({ httpStatus: 503 });
    expect(apiCalls(calls)).toHaveLength(3);
  });

  it("rejects a 2xx response that doesn't match the expected shape", async () => {
    const { paypal } = client([TOKEN, { status: 201, body: { status: "COMPLETED" } }]);
    await expect(paypal.captureAuthorization("AUTH-1", "r")).rejects.toMatchObject({
      code: "PAYPAL_ERROR",
      issue: "UNEXPECTED_RESPONSE",
    });
  });
});

describe("verifyWebhook", () => {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-sig": "sig==",
    "paypal-transmission-time": "2026-10-29T10:00:00Z",
  };
  // Odd spacing and key order on purpose: it must reach PayPal unchanged.
  const rawBody = '{ "id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1"} }';

  it("posts the header fields, webhook_id and the raw event bytes", async () => {
    const { paypal, calls } = client([TOKEN, { status: 200, body: { verification_status: "SUCCESS" } }]);
    expect(await paypal.verifyWebhook({ headers, rawBody, webhookId: "WHID" })).toBe(true);
    const c = apiCalls(calls)[0]!;
    expect(c.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v1/notifications/verify-webhook-signature`);
    expect(c.headers["PayPal-Request-Id"]).toBeTruthy();
    expect(c.body).toContain(`"webhook_event":${rawBody}}`);
    expect(JSON.parse(c.body!)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: headers["paypal-cert-url"],
      transmission_id: "tx-1",
      transmission_sig: "sig==",
      transmission_time: "2026-10-29T10:00:00Z",
      webhook_id: "WHID",
      webhook_event: JSON.parse(rawBody),
    });
  });

  it("returns false on FAILURE", async () => {
    const { paypal } = client([TOKEN, { status: 200, body: { verification_status: "FAILURE" } }]);
    expect(await paypal.verifyWebhook({ headers, rawBody, webhookId: "WHID" })).toBe(false);
  });

  it.each(Object.keys(headers))("fails closed without calling PayPal when %s is missing", async (name) => {
    const { paypal, calls } = client([TOKEN]);
    const partial: Record<string, string | undefined> = { ...headers, [name]: undefined };
    expect(await paypal.verifyWebhook({ headers: partial, rawBody, webhookId: "WHID" })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on repeated headers, empty webhook id or a body that isn't a JSON object", async () => {
    const { paypal, calls } = client([TOKEN]);
    const repeated = { ...headers, "paypal-transmission-sig": ["a", "b"] };
    expect(await paypal.verifyWebhook({ headers: repeated, rawBody, webhookId: "WHID" })).toBe(false);
    expect(await paypal.verifyWebhook({ headers, rawBody, webhookId: "" })).toBe(false);
    for (const bad of ["", "not json", "[]", "null", '"str"', '{"a":1},"webhook_id":"evil"']) {
      expect(await paypal.verifyWebhook({ headers, rawBody: bad, webhookId: "WHID" })).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("network failures", () => {
  function failing(err: Error) {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/oauth2/token")) return new Response(JSON.stringify(TOKEN.body), { status: 200 });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw err;
    }) as typeof globalThis.fetch;
    return createPayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: "c", clientSecret: "s", fetch });
  }

  it("wraps a lost connection on POST as PAYPAL_ERROR that may have been applied", async () => {
    const err = (await failing(new TypeError("fetch failed"))
      .captureAuthorization("AUTH-1", "r")
      .catch((e: unknown) => e)) as PayPalApiError;
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({ code: "PAYPAL_ERROR", httpStatus: 0, issue: "NETWORK_ERROR", maybeApplied: true });
  });

  it("marks a timeout as TIMEOUT; a failed GET was not applied", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    await expect(failing(timeout).getOrder("O-1")).rejects.toMatchObject({ issue: "TIMEOUT", maybeApplied: false });
  });

  it("flags a POST 5xx as maybe applied but a 4xx as not", async () => {
    const a = client([TOKEN, { status: 500 }, { status: 500 }, { status: 500 }]);
    await expect(a.paypal.captureAuthorization("AUTH-1", "r")).rejects.toMatchObject({ maybeApplied: true });
    const b = client([TOKEN, { status: 422, body: { name: "UNPROCESSABLE_ENTITY" } }]);
    await expect(b.paypal.captureAuthorization("AUTH-1", "r")).rejects.toMatchObject({ maybeApplied: false });
  });

  it("wraps a body that fails mid-read after headers arrived", async () => {
    const stalled = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/oauth2/token")) return new Response(JSON.stringify(TOKEN.body), { status: 200 });
      const body = new ReadableStream({
        start(c) {
          c.error(new TypeError("terminated"));
        },
      });
      return new Response(body, { status: 201 });
    }) as typeof globalThis.fetch;
    const paypal = createPayPalClient({
      baseUrl: PAYPAL_SANDBOX_BASE_URL,
      clientId: "c",
      clientSecret: "s",
      fetch: stalled,
    });
    await expect(paypal.captureAuthorization("AUTH-1", "r")).rejects.toMatchObject({
      code: "PAYPAL_ERROR",
      issue: "NETWORK_ERROR",
      maybeApplied: true,
    });
  });

  it("flags an unreadable 2xx POST reply as maybe applied", async () => {
    const { paypal } = client([TOKEN, { status: 201, body: { unexpected: true } }]);
    await expect(paypal.captureAuthorization("AUTH-1", "r")).rejects.toMatchObject({
      issue: "UNEXPECTED_RESPONSE",
      maybeApplied: true,
    });
  });
});
