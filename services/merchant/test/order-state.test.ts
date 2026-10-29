import { OrderStatus } from "@handshake/core";
import { describe, expect, it } from "vitest";
import { InvalidTransitionError, isTerminal, transition, type OrderEvent } from "../src/orders/state.js";

const api = (to: OrderEvent["to"]): OrderEvent => ({ to, source: "api" });
const hook = (to: OrderEvent["to"]): OrderEvent => ({ to, source: "webhook" });

describe("order state machine", () => {
  it.each([
    ["offered", "authorized"],
    ["offered", "failed"],
    ["authorized", "captured"],
    ["authorized", "voided"],
    ["authorized", "failed"],
    ["captured", "refunded"],
  ] as const)("allows %s → %s", (from, to) => {
    expect(transition(from, api(to))).toEqual({ status: to, changed: true });
    expect(transition(from, hook(to))).toEqual({ status: to, changed: true });
  });

  it("walks the happy path offered → authorized → captured → refunded", () => {
    let s: OrderStatus = "offered";
    for (const to of ["authorized", "captured", "refunded"] as const) s = transition(s, api(to)).status;
    expect(s).toBe("refunded");
  });

  it("treats a repeated confirmation as a no-op (API then webhook)", () => {
    const afterApi = transition("authorized", api("captured"));
    expect(transition(afterApi.status, hook("captured"))).toEqual({ status: "captured", changed: false });
  });

  it.each([
    ["captured", "authorized"],
    ["refunded", "captured"],
    ["refunded", "authorized"],
    ["voided", "authorized"],
    ["failed", "offered"],
  ] as const)("ignores a stale %s ← %s confirmation", (from, to) => {
    expect(transition(from, hook(to))).toEqual({ status: from, changed: false });
  });

  it.each([
    ["offered", "captured"], // never capture without an authorization
    ["offered", "voided"],
    ["offered", "refunded"],
    ["authorized", "refunded"],
    ["captured", "voided"], // money taken: only refund moves it
    ["captured", "failed"],
    ["voided", "captured"], // a voided authorization can't be captured
    ["voided", "refunded"],
    ["refunded", "failed"],
    ["failed", "authorized"],
    ["failed", "captured"],
  ] as const)("rejects %s → %s", (from, to) => {
    expect(() => transition(from, hook(to))).toThrow(InvalidTransitionError);
  });

  it("covers every (status, event) pair: each is applied, ignored or rejected", () => {
    for (const from of OrderStatus.options) {
      for (const to of OrderStatus.options) {
        try {
          const r = transition(from, api(to));
          expect(r.changed ? r.status === to : r.status === from).toBe(true);
        } catch (e) {
          expect(e).toBeInstanceOf(InvalidTransitionError);
        }
      }
    }
  });

  it("marks refunded, voided and failed terminal", () => {
    expect(OrderStatus.options.filter(isTerminal).sort()).toEqual(["failed", "refunded", "voided"]);
  });
});
