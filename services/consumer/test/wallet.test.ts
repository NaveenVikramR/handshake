import { hash, randomNonce, shipToHash } from "@handshake/core";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApproval } from "../src/approvals/service.js";
import { harness, shipTo, type Harness } from "./agent-harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function signedIn(hh: Harness) {
  const { userId, auth } = await hh.registerUser();
  const token = await hh.signIn(userId, auth);
  const as = (r: request.Test) => r.set("authorization", `Bearer ${token}`);
  return { userId, auth, token, as };
}

const mandateBody = {
  merchants: ["mer_corner"],
  categories: ["grocery"],
  perOrderMinor: 3000,
  periodMinor: 8000,
  period: "week",
  shipTo,
  days: 7,
};

describe("wallet API (M8)", () => {
  it("GET /me: the session's user, passkeys (short ids) and no PayPal yet", async () => {
    h = await harness();
    const u = await signedIn(h);
    const me = await u.as(request(h.app).get("/me"));
    expect(me.body).toMatchObject({ userId: u.userId, displayName: "Alice", paypal: null });
    expect(me.body.passkeys[0].id).toHaveLength(10);
    expect((await request(h.app).get("/me")).status).toBe(401);
  });

  it("logout ends the session", async () => {
    h = await harness();
    const u = await signedIn(h);
    expect((await u.as(request(h.app).post("/logout"))).status).toBe(200);
    expect((await u.as(request(h.app).get("/me"))).status).toBe(401);
  });

  it("GET /mandates/:id renders the stored mandate with options; the user approves that; list shows spend", async () => {
    h = await harness();
    const u = await signedIn(h);
    const created = await u.as(request(h.app).post("/mandates/options")).send(mandateBody);
    const view = await u.as(request(h.app).get(`/mandates/${created.body.mandateId}`));
    expect(view.body).toMatchObject({
      status: "pending",
      merchants: [{ id: "mer_corner", name: "Corner Grocery", verified: true }],
    });
    expect(view.body.options.challenge).toBe(hash(view.body.mandate));
    const ok = await u.as(request(h.app).post("/mandates/verify")).send({
      mandateId: created.body.mandateId,
      response: u.auth.assertJSON(view.body.options.challenge),
    });
    expect(ok.body.status).toBe("active");
    const list = await u.as(request(h.app).get("/mandates"));
    expect(list.body.mandates[0]).toMatchObject({ status: "active", spentMinor: 0, limits: { periodMinor: 8000 } });
  });

  it("another user can't read or revoke my mandate", async () => {
    h = await harness();
    const alice = await signedIn(h);
    const bob = await signedIn(h);
    const created = await alice.as(request(h.app).post("/mandates/options")).send(mandateBody);
    expect((await bob.as(request(h.app).get(`/mandates/${created.body.mandateId}`))).status).toBe(404);
    expect((await bob.as(request(h.app).post(`/mandates/${created.body.mandateId}/revoke`))).status).toBe(404);
  });

  it("revoke: the mandate stops being offered to the agent", async () => {
    h = await harness();
    const u = await signedIn(h);
    const created = await u.as(request(h.app).post("/mandates/options")).send(mandateBody);
    const view = await u.as(request(h.app).get(`/mandates/${created.body.mandateId}`));
    await u.as(request(h.app).post("/mandates/verify")).send({
      mandateId: created.body.mandateId,
      response: u.auth.assertJSON(view.body.options.challenge),
    });
    expect((await u.as(request(h.app).post(`/mandates/${created.body.mandateId}/revoke`))).body.status).toBe("revoked");
    expect(await h.store.listActiveMandates(u.userId)).toHaveLength(0);
    expect((await h.store.getMandate(created.body.mandateId))?.status).toBe("revoked");
  });

  it("approval page: registry badge, and the address only when it hashes to the cart's ship-to", async () => {
    h = await harness();
    const { userId } = await h.registerUser();
    const iat = Math.floor(Date.now() / 1000);
    const cart = {
      v: 1,
      type: "cart_approval",
      offerId: "off_1",
      offerHash: hash({ o: 1 }),
      merchantId: "mer_corner",
      items: [{ sku: "RICE-2KG", name: "Rice", qty: 1, unitMinor: 499 }],
      totalMinor: 499,
      currency: "USD",
      shipToHash: shipToHash(shipTo),
      consumerAgentId: "agt_c_wallet",
      userId,
      iat,
      exp: iat + 300,
      nonce: randomNonce(),
    };
    const good = await createApproval(h.ctx, cart, shipTo);
    const page = await request(h.app).get(`/approvals/${good.id}`);
    expect(page.body.merchant).toEqual({ id: "mer_corner", name: "Corner Grocery", verified: true });
    // Masked on the bearer link: no street line.
    expect(page.body.shipTo).toEqual({ name: "Alice", city: "Springfield", postalCode: "12345", country: "US" });
    // An address that doesn't match the signed hash is never shown.
    const other = await createApproval(
      h.ctx,
      { ...cart, nonce: randomNonce() },
      { ...shipTo, line1: "9 Elsewhere Rd" },
    );
    expect((await request(h.app).get(`/approvals/${other.id}`)).body.shipTo).toBeUndefined();
  });

  it("a cancelled approval (its chat closed) can't be approved", async () => {
    h = await harness();
    const { userId } = await h.registerUser();
    const iat = Math.floor(Date.now() / 1000);
    const { id } = await createApproval(h.ctx, {
      v: 1,
      type: "cart_approval",
      offerId: "off_1",
      offerHash: hash({ o: 1 }),
      merchantId: "mer_corner",
      items: [{ sku: "RICE-2KG", name: "Rice", qty: 1, unitMinor: 499 }],
      totalMinor: 499,
      currency: "USD",
      shipToHash: shipToHash(shipTo),
      consumerAgentId: "agt_c_wallet",
      userId,
      iat,
      exp: iat + 300,
      nonce: randomNonce(),
    });
    expect(await h.store.cancelApproval(id)).toBe(true);
    expect((await request(h.app).get(`/approvals/${id}`)).body).toEqual({ error: "APPROVAL_EXPIRED" });
  });

  it("PayPal payer confirmation is single-use and bound to the payer shown", async () => {
    h = await harness();
    const u = await signedIn(h);
    h.gate.vaults.set(u.userId, { vaultId: "VAULT-1", payerId: "P1", payerEmail: "p1@example.com", status: "pending" });
    const link = await u.as(request(h.app).get("/wallet/paypal"));
    // The saved wallet changes between showing and confirming (a different payer saved meanwhile).
    h.gate.vaults.set(u.userId, { vaultId: "VAULT-2", payerId: "P2", payerEmail: "p2@example.com", status: "pending" });
    const res = await u.as(request(h.app).post("/wallet/paypal/confirm")).send({
      linkId: link.body.linkId,
      response: u.auth.assertJSON(link.body.options.challenge),
    });
    expect(res.body).toEqual({ error: "APPROVAL_INVALID" });
    expect(h.gate.vaults.get(u.userId)?.status).toBe("pending");
    // And the link can't be tried again.
    const again = await u.as(request(h.app).post("/wallet/paypal/confirm")).send({
      linkId: link.body.linkId,
      response: u.auth.assertJSON(link.body.options.challenge),
    });
    expect(again.body).toEqual({ error: "APPROVAL_EXPIRED" });
  });
});
