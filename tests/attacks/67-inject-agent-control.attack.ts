import { hash, shipToHash } from "../../packages/core/src/index.js";
import { runChat } from "../../services/consumer/src/agent/loop.js";
import { activateMandate, createMandate } from "../../services/consumer/src/mandates/service.js";
import { harness, lastResult, scriptedPlanner, shipTo } from "../../services/consumer/test/agent-harness.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A67",
  title: "Control: the same agent script buying rice pays through the mandate",
  category: "control",
  spec: "control",
  expect: "OK",
  expectAuthorized: true,
  authorizations: 0,
  async run() {
    const c = await harness();
    try {
      const { userId, auth } = await c.registerUser();
      const { mandateId, mandate } = await createMandate(c.ctx, {
        userId,
        merchants: ["mer_corner"],
        categories: ["grocery"],
        perOrderMinor: 3000,
        periodMinor: 8000,
        period: "week",
        shipTo,
        days: 7,
      });
      await activateMandate(c.ctx, mandateId, auth.assert(hash(mandate)));
      const planner = scriptedPlanner([
        () => ({ calls: [["discover_merchants", {}]] }),
        () => ({ calls: [["get_catalog", { merchantId: "mer_corner" }]] }),
        () => ({ calls: [["request_offer", { merchantId: "mer_corner", items: [{ sku: "RICE-2KG", qty: 1 }] }]] }),
        (m) => ({ calls: [["verify_offer", { offerId: lastResult(m).offerId as string }]] }),
        (m) => ({ calls: [["checkout", { offerId: lastResult(m).offerId as string }]] }),
        () => ({ content: "Bought it." }),
      ]);
      const stop = new AbortController();
      let stepUp = false;
      await runChat(
        c.ctx,
        { ...c.agent, planner },
        { userId, message: "1 rice please", shipToHash: shipToHash(shipTo), shipTo },
        (e) => {
          if (e.type === "approval_required") {
            stepUp = true;
            stop.abort();
          }
        },
        { signal: stop.signal, log: () => {} },
      );
      return { code: stepUp ? "STEP_UP_REQUIRED" : c.paid.length === 1 ? "OK" : "NOT_PAID", authorized: c.paid.length > 0 };
    } finally {
      await c.close();
    }
  },
});
