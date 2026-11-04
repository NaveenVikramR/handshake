import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { dashboardRouter } from "../src/dashboard/routes.js";
import { demoDatabaseMatches } from "../src/demo.js";
import { ADMIN, USER, gateFixture } from "./gate-fixture.js";

const admin = (r: request.Test) => r.set("authorization", `Bearer ${ADMIN}`);

async function heldOrder() {
  const f = await gateFixture();
  f.gate.vaults.set(USER, { vaultId: "VAULT-1", payerId: "P1", payerEmail: "p@example.com", status: "confirmed" });
  const res = await f.pay(f.passkeyRequest(await f.offer()));
  expect(res.body.status).toBe("authorized");
  return f;
}

describe("demo reset (M10, DEMO_MODE only)", () => {
  it("voids held authorizations at PayPal, then clears the payment data", async () => {
    const f = await heldOrder();
    const order = [...f.gate.orders.values()][0]!;
    const res = await admin(request(f.app).post("/demo/reset")).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orders: 1, voided: 1 });
    expect(f.paypal.calls.find((c) => c.op === "void")?.args).toBe(order.authorizationId);
    expect(f.gate.orders.size).toBe(0);
    expect(f.gate.decisions).toHaveLength(0);
    // The saved wallet stays: the next take needs no PayPal redirect.
    expect(f.gate.vaults.get(USER)?.status).toBe("confirmed");
  });

  it("needs the admin token", async () => {
    const f = await heldOrder();
    expect((await request(f.app).post("/demo/reset").send({})).status).toBe(401);
    expect(f.gate.orders.size).toBe(1);
  });

  it("isn't mounted without DEMO_MODE; the feed says which mode it is", async () => {
    const f = await heldOrder();
    const app = express().use(dashboardRouter(f.ctx, { adminToken: ADMIN, demoMode: false, demoReset: true }));
    expect((await admin(request(app).post("/demo/reset")).send({})).status).toBe(404);
    expect((await admin(request(app).get("/dashboard/recent"))).body.demoMode).toBe(false);
    expect((await admin(request(f.app).get("/dashboard/recent"))).body.demoMode).toBe(true);
    expect(f.gate.orders.size).toBe(1);
  });

  it("DEMO_MODE on another database (host mismatch): no reset route, the feed says so", async () => {
    const f = await heldOrder();
    const app = express().use(dashboardRouter(f.ctx, { adminToken: ADMIN, demoMode: true, demoReset: false }));
    expect((await admin(request(app).post("/demo/reset")).send({})).status).toBe(404);
    expect((await admin(request(app).get("/dashboard/recent"))).body).toMatchObject({ demoMode: true, demoReset: false });
    expect(f.gate.orders.size).toBe(1);
  });

  it("an order authorized while the reset runs stops it: no hold is dropped", async () => {
    const f = await heldOrder();
    const before = f.gate.store.heldOrders.bind(f.gate.store);
    // The listing misses an authorization that lands right after it.
    f.gate.store.heldOrders = async () => (await before()).slice(1);
    const res = await admin(request(f.app).post("/demo/reset")).send({});
    expect(res.status).toBe(500);
    expect(f.gate.orders.size).toBe(1);
  });
});

describe("demoDatabaseMatches (D26)", () => {
  const dev = "postgresql://u:p@ep-dev-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
  it("matches only the configured host", () => {
    expect(demoDatabaseMatches(dev, "ep-dev-123.us-east-2.aws.neon.tech")).toBe(true);
    expect(demoDatabaseMatches(dev, " EP-DEV-123.us-east-2.aws.neon.tech ")).toBe(true);
  });
  it.each([
    ["another host (main branch)", dev.replace("ep-dev-123", "ep-main-456"), "ep-dev-123.us-east-2.aws.neon.tech"],
    ["no host configured", dev, ""],
    ["no database url", undefined, "ep-dev-123.us-east-2.aws.neon.tech"],
    ["not a url", "nonsense", "nonsense"],
  ])("refuses %s", (_n, url, host) => {
    expect(demoDatabaseMatches(url, host)).toBe(false);
  });
});
