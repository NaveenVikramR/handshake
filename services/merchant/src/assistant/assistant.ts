// Shopkeeper assistant (SPEC §8, §10 POST /assistant): reads gate decisions, orders and, via
// @paypal/agent-toolkit, PayPal data. Every toolkit action enabled here is read-only; refunds are
// only ever proposed and run through our own route after the shopkeeper confirms.
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionTool } from "openai/resources";
import { z } from "zod";
import type { GateStore } from "../gate/store.js";

export const MAX_ASSISTANT_ROUNDS = 6;
const SYSTEM = readFileSync(new URL("./prompts/assistant.md", import.meta.url), "utf8");

/** Toolkit actions the assistant may use: reads only (rule: no money moves without a human). */
export const READ_ONLY_PAYPAL_ACTIONS = {
  orders: { get: true },
  transactions: { list: true },
  disputes: { list: true, get: true },
  shipment: { get: true },
  payments: { getRefunds: true },
} as const;

/** The parts of PayPalAgentToolkit we use, so tests can stand in for it. */
/** Toolkit tool names that read only; startup refuses anything else (no money moves). */
export const READ_ONLY_TOOL_NAMES = new Set([
  "get_order",
  "list_transactions",
  "list_disputes",
  "get_dispute",
  "get_shipment_tracking",
  "get_refund",
]);

export function assertReadOnly(tools: { type: string; function?: { name: string } }[]): void {
  const extra = tools.flatMap((t) => (t.function && !READ_ONLY_TOOL_NAMES.has(t.function.name) ? [t.function.name] : []));
  if (extra.length) throw new Error(`assistant toolkit exposes non-read-only tools: ${extra.join(", ")}`);
}

export interface PayPalTools {
  getTools(): ChatCompletionTool[];
  handleToolCall(call: ChatCompletionMessageToolCall): Promise<{ content: unknown }>;
}

export type AssistantModel = (
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
) => Promise<{ content: string | null; toolCalls: ChatCompletionMessageToolCall[] }>;

export interface RefundProposal {
  action: "refund";
  orderId: string;
  totalMinor: number;
  currency: string;
}

export interface AssistantDeps {
  store: Pick<GateStore, "listRecent" | "getOrder">;
  model: AssistantModel;
  paypal?: PayPalTools;
}

const OurTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_recent_requests",
      description: "Recent payment requests with gate outcome, order status and total.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_request",
      description: "Every gate check for one payment request, with result and reason.",
      parameters: {
        type: "object",
        properties: { requestId: { type: "string" } },
        required: ["requestId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_refund",
      description: "Propose a full refund of a captured order. Only shows a confirm card; nothing is refunded.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  },
];

const ById = z.strictObject({ requestId: z.string().regex(/^req_[A-Za-z0-9_-]{1,64}$/) });
const ByOrder = z.strictObject({ orderId: z.string().regex(/^ord_[A-Za-z0-9_-]{1,64}$/) });

export function openAIAssistantModel(opts: { baseURL: string; apiKey: string; model: string }): AssistantModel {
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey, timeout: 30_000, maxRetries: 1 });
  return async (messages, tools) => {
    const res = await client.chat.completions.create({ model: opts.model, temperature: 0, messages, tools });
    const msg = res.choices[0]?.message;
    return {
      content: msg?.content ?? null,
      toolCalls: (msg?.tool_calls ?? []).filter(
        (c): c is ChatCompletionMessageToolCall & { type: "function" } => c.type === "function",
      ),
    };
  };
}

export async function askAssistant(
  deps: AssistantDeps,
  message: string,
  log: (msg: string, fields: Record<string, unknown>) => void = () => {},
): Promise<{ reply: string; proposals: RefundProposal[] }> {
  const paypalTools = deps.paypal?.getTools() ?? [];
  const paypalNames = new Set(paypalTools.flatMap((t) => (t.type === "function" ? [t.function.name] : [])));
  const tools = [...OurTools, ...paypalTools];
  const proposals: RefundProposal[] = [];
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: message },
  ];

  async function run(call: ChatCompletionMessageToolCall): Promise<unknown> {
    if (call.type !== "function") return { error: "UNKNOWN_TOOL" };
    const name = call.function.name;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { error: "SCHEMA_INVALID" };
    }
    log("assistant tool", { tool: name });
    if (name === "list_recent_requests") {
      return (await deps.store.listRecent(20)).map((r) => ({
        requestId: r.requestId,
        outcome: r.decisions.at(-1)?.result ?? "unknown",
        failedStep: r.decisions.find((d) => d.result === "fail")?.step ?? null,
        order: r.order && { orderId: r.order.id, status: r.order.status, totalMinor: r.order.totalMinor },
      }));
    }
    if (name === "explain_request") {
      const a = ById.safeParse(args);
      if (!a.success) return { error: "SCHEMA_INVALID" };
      const r = (await deps.store.listRecent(200)).find((x) => x.requestId === a.data.requestId);
      return r
        ? { requestId: r.requestId, decisions: r.decisions, orderStatus: r.order?.status ?? null }
        : { error: "UNKNOWN_REQUEST" };
    }
    if (name === "propose_refund") {
      const a = ByOrder.safeParse(args);
      if (!a.success) return { error: "SCHEMA_INVALID" };
      const o = await deps.store.getOrder(a.data.orderId);
      if (!o || o.status !== "captured") return { error: "ORDER_NOT_REFUNDABLE", status: o?.status ?? null };
      proposals.push({ action: "refund", orderId: o.id, totalMinor: o.totalMinor, currency: o.currency });
      return { proposed: true, note: "The shopkeeper must press Confirm; nothing has been refunded." };
    }
    if (paypalNames.has(name) && deps.paypal) {
      try {
        return (await deps.paypal.handleToolCall(call)).content;
      } catch {
        return { error: "PAYPAL_ERROR" };
      }
    }
    return { error: "UNKNOWN_TOOL" };
  }

  for (let round = 0; round < MAX_ASSISTANT_ROUNDS; round++) {
    const reply = await deps.model(messages, tools);
    const content = reply.content;
    // Keep (and answer) at most 4 calls, so every call in the history has its tool message.
    const toolCalls = reply.toolCalls.slice(0, 4);
    messages.push({ role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    if (!toolCalls.length) return { reply: content ?? "", proposals };
    for (const call of toolCalls) {
      const out = await run(call);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof out === "string" ? out : JSON.stringify(out),
      });
    }
  }
  return { reply: "I couldn't finish that in time; try a narrower question.", proposals };
}
