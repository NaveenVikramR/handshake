// Stretch (D35): the consumer agent talks to the real merchant over MCP (POST /mcp) and the same
// gate decides. Nothing about verification changes with the transport.
import { hash, shipToHash } from "@handshake/core";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { runChat } from "../src/agent/loop.js";
import { mcpMerchantClient } from "../src/agent/merchant-mcp.js";
import type { PlannerMessage } from "../src/agent/planner.js";
import type { AgentEvent } from "../src/agent/tools.js";
import { activateMandate, createMandate } from "../src/mandates/service.js";
import { harness, lastResult, scriptedPlanner, shipTo, type Harness } from "./agent-harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const buy = [
  () => ({ calls: [["discover_merchants", {}]] as [string, object][] }),
  () => ({
    calls: [["request_offer", { merchantId: "mer_corner", items: [{ sku: "RICE-2KG", qty: 1 }] }]] as [
      string,
      object,
    ][],
  }),
  (m: PlannerMessage[]) => ({
    calls: [["checkout", { offerId: lastResult(m).offerId as string }]] as [string, object][],
  }),
  () => ({ content: "ok" }),
];

describe("consumer ↔ merchant over MCP", () => {
  it("answers the card and catalog through the shared parsers", async () => {
    h = await harness();
    const client = mcpMerchantClient(h.merchantUrl);
    expect(await client.card()).toMatchObject({ merchantId: "mer_corner", merchantAgentId: "agt_m_corner" });
    const catalog = await client.catalog();
    expect(catalog.merchantId).toBe("mer_corner");
    expect(catalog.products.map((p) => p.sku)).toContain("RICE-2KG");
  });

  it("a chat over MCP ends in a gate receipt, the mandate path (6b) included", async () => {
    h = await harness();
    const { userId, auth } = await h.registerUser();
    const { mandateId, mandate } = await createMandate(h.ctx, {
      userId,
      merchants: ["mer_corner"],
      categories: ["grocery"],
      perOrderMinor: 3000,
      periodMinor: 8000,
      period: "week",
      shipTo,
      days: 7,
    });
    await activateMandate(h.ctx, mandateId, auth.assert(hash(mandate)));
    const events: AgentEvent[] = [];
    await runChat(
      h.ctx,
      { ...h.agent, merchantTransport: "mcp", planner: scriptedPlanner(buy) },
      { userId, message: "buy 1 rice", shipToHash: shipToHash(shipTo), shipTo },
      (e) => events.push(e),
      { log: () => {} },
    );
    const receipt = events.find((e) => e.type === "receipt") as {
      receipt: { status: string; decisions: { step: string }[] };
    };
    expect(receipt.receipt.status).toBe("authorized");
    expect(receipt.receipt.decisions.map((d) => d.step)).toContain("6b");
  });

  it("gate refusals keep their codes over MCP: a tampered payment request fails closed", async () => {
    h = await harness();
    const client = mcpMerchantClient(h.merchantUrl);
    await expect(client.pay({ requestId: "req_x" } as never)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await expect(client.requestOffer({ payload: {} } as never)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    // Not even an object: the gate's code, as on REST, not the MCP SDK's own validation text.
    await expect(client.pay("not a request" as never)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("an unreachable MCP endpoint is MERCHANT_UNTRUSTED, and GET /mcp is refused", async () => {
    h = await harness();
    await expect(mcpMerchantClient("http://127.0.0.1:1").card()).rejects.toMatchObject({ code: "MERCHANT_UNTRUSTED" });
    const r = await request(h.merchantUrl).get("/mcp");
    expect(r.status).toBe(405);
  });
});
