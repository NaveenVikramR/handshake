import type { ChatCompletionMessageToolCall } from "openai/resources";
import { describe, expect, it } from "vitest";
import { READ_ONLY_PAYPAL_ACTIONS, askAssistant, type AssistantModel } from "../src/assistant/assistant.js";
import { memoryGateStore, type OrderRow } from "../src/gate/store.js";

const call = (id: string, name: string, args: object): ChatCompletionMessageToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

function scripted(
  steps: ((seen: unknown[]) => { content?: string; calls?: ChatCompletionMessageToolCall[] })[],
): AssistantModel & { seen: unknown[][] } {
  let i = 0;
  const seen: unknown[][] = [];
  const model: AssistantModel = async (messages) => {
    seen.push([...messages]);
    const s = steps[i++]?.(messages) ?? { content: "done" };
    return { content: s.content ?? null, toolCalls: s.calls ?? [] };
  };
  return Object.assign(model, { seen });
}

const order = (patch: Partial<OrderRow>): OrderRow => ({
  id: "ord_1",
  requestId: "req_1",
  userId: "usr_a",
  offerId: "off_1",
  status: "captured",
  path: "passkey",
  totalMinor: 499,
  currency: "USD",
  offerHash: "h",
  approvalHash: "a",
  mandateId: null,
  periodStart: null,
  paypalOrderId: "PP1",
  authorizationId: "AU1",
  captureId: "CA1",
  refundId: null,
  refundedMinor: 0,
  payerActionUrl: null,
  trackingNumber: null,
  fulfilBy: 0,
  createdAt: 0,
  ...patch,
});

describe("shopkeeper assistant", () => {
  it("only reads: the PayPal toolkit is configured with read actions and no capture/refund/create", () => {
    const enabled = Object.entries(READ_ONLY_PAYPAL_ACTIONS).flatMap(([p, a]) =>
      Object.keys(a).map((k) => `${p}.${k}`),
    );
    expect(enabled.sort()).toEqual([
      "disputes.get",
      "disputes.list",
      "orders.get",
      "payments.getRefunds",
      "shipment.get",
      "transactions.list",
    ]);
  });

  it("a refund is only proposed: nothing moves money, the reply carries a confirm card", async () => {
    const g = memoryGateStore({});
    g.orders.set("ord_1", order({}));
    const model = scripted([
      () => ({ calls: [call("c1", "propose_refund", { orderId: "ord_1" })] }),
      () => ({ content: "Proposed a refund." }),
    ]);
    const out = await askAssistant({ store: g.store, model }, "refund the last order");
    expect(out.proposals).toEqual([{ action: "refund", orderId: "ord_1", totalMinor: 499, currency: "USD" }]);
    expect(g.orders.get("ord_1")?.status).toBe("captured");
  });

  it("refuses to propose refunding an order that isn't captured", async () => {
    const g = memoryGateStore({});
    g.orders.set("ord_1", order({ status: "authorized" }));
    const model = scripted([
      () => ({ calls: [call("c1", "propose_refund", { orderId: "ord_1" })] }),
      () => ({ content: "x" }),
    ]);
    const out = await askAssistant({ store: g.store, model }, "refund");
    expect(out.proposals).toEqual([]);
    expect(JSON.stringify(model.seen[1])).toContain("ORDER_NOT_REFUNDABLE");
  });

  it("explains a blocked request from its decisions; unknown tools and bad args are errors to the model", async () => {
    const g = memoryGateStore({});
    await g.store.addDecisions("req_9", [
      { step: "1", result: "pass", reason: "schema" },
      { step: "5", result: "fail", reason: "CART_MISMATCH: cart differs from the offer" },
    ]);
    const model = scripted([
      () => ({
        calls: [
          call("c1", "explain_request", { requestId: "req_9" }),
          call("c2", "create_refund", { capture_id: "X" }),
          call("c3", "explain_request", { requestId: "not-a-request" }),
        ],
      }),
      () => ({ content: "It failed at step 5." }),
    ]);
    const out = await askAssistant({ store: g.store, model }, "why blocked?");
    expect(out.reply).toBe("It failed at step 5.");
    const toolMsgs = JSON.stringify(model.seen[1]);
    expect(toolMsgs).toContain("CART_MISMATCH");
    expect(toolMsgs).toContain("UNKNOWN_TOOL");
    expect(toolMsgs).toContain("SCHEMA_INVALID");
  });

  it("toolkit tools run only if the toolkit offered them", async () => {
    const g = memoryGateStore({});
    const handled: string[] = [];
    const paypal = {
      getTools: () => [{ type: "function" as const, function: { name: "get_order", parameters: {} } }],
      handleToolCall: async (c: ChatCompletionMessageToolCall) => {
        handled.push(c.type === "function" ? c.function.name : "?");
        return { content: '{"id":"PP1","status":"COMPLETED"}' };
      },
    };
    const model = scripted([
      () => ({ calls: [call("c1", "get_order", { id: "PP1" }), call("c2", "create_order", {})] }),
      () => ({ content: "ok" }),
    ]);
    await askAssistant({ store: g.store, model, paypal }, "show PP1");
    expect(handled).toEqual(["get_order"]);
  });
});
