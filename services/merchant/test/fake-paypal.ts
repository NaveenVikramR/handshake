// In-memory PayPal for gate tests: Orders v2 authorize flow with saved wallets, idempotent per
// PayPal-Request-Id (a replay returns the original result), as docs/PAYPAL.md records.
import { PayPalApiError, type PayPalClient, type PayPalOrder } from "../src/paypal/client.js";

type Calls = { op: string; requestId?: string; args: unknown }[];

export function fakePayPal(opts: { autoApprove?: boolean } = {}) {
  const calls: Calls = [];
  const orders = new Map<string, PayPalOrder>();
  const byRequest = new Map<string, unknown>();
  let n = 0;
  const fail = { create: undefined as PayPalApiError | undefined };

  const once = <T>(op: string, requestId: string, make: () => T): T => {
    const key = `${op}:${requestId}`;
    if (!byRequest.has(key)) byRequest.set(key, make());
    return byRequest.get(key) as T;
  };
  const authorized = (id: string, vault?: string): PayPalOrder => ({
    id,
    status: "COMPLETED",
    purchase_units: [{ payments: { authorizations: [{ id: `AUTH${id}`, status: "CREATED" }] } }],
    ...(vault ? { payment_source: { paypal: { attributes: { vault: { id: vault, status: "VAULTED" } } } } } : {}),
  });

  const client: Pick<
    PayPalClient,
    | "createOrderAuthorize"
    | "getOrder"
    | "authorizeOrder"
    | "captureAuthorization"
    | "voidAuthorization"
    | "addTracking"
  > = {
    async createOrderAuthorize(input) {
      calls.push({ op: "create", requestId: input.requestId, args: input });
      if (fail.create) throw fail.create;
      return once("create", input.requestId, () => {
        const id = `ORD${++n}`;
        const o: PayPalOrder = input.vaultId
          ? authorized(id)
          : {
              id,
              status: "PAYER_ACTION_REQUIRED",
              links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
            };
        orders.set(id, o);
        return o;
      });
    },
    async getOrder(id) {
      calls.push({ op: "get", args: id });
      const o = orders.get(id);
      if (!o) throw new PayPalApiError(404, "RESOURCE_NOT_FOUND", undefined);
      if (opts.autoApprove && o.status === "PAYER_ACTION_REQUIRED") o.status = "APPROVED";
      return o;
    },
    async authorizeOrder(id, requestId) {
      calls.push({ op: "authorize", requestId, args: id });
      return once("authorize", requestId, () => {
        const o = orders.get(id);
        if (o?.status !== "APPROVED") throw new PayPalApiError(422, "ORDER_NOT_APPROVED", undefined);
        const done = authorized(id, `VAULT-${id}`);
        orders.set(id, done);
        return done;
      });
    },
    async captureAuthorization(authId, requestId) {
      calls.push({ op: "capture", requestId, args: authId });
      return once("capture", requestId, () => ({ id: `CAP${authId}`, status: "COMPLETED" }));
    },
    async voidAuthorization(authId, requestId) {
      calls.push({ op: "void", requestId, args: authId });
      return once("void", requestId, () => ({ id: authId, status: "VOIDED" }));
    },
    async addTracking(orderId, requestId, input) {
      calls.push({ op: "track", requestId, args: { orderId, ...input } });
      return once("track", requestId, () => ({ id: orderId, status: "COMPLETED" }));
    },
  };
  /** The buyer approves on PayPal. */
  const approve = (paypalOrderId: string) => {
    const o = orders.get(paypalOrderId);
    if (o) o.status = "APPROVED";
  };
  return { client, calls, orders, approve, fail };
}
