// GET /orders/:id/evidence (bearer MERCHANT_ADMIN_TOKEN): the signed dispute evidence pack (D36).
import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../gate/routes.js";
import { EvidenceError, buildEvidencePack, type EvidenceDeps } from "./evidence.js";

const OrderId = z.string().regex(/^ord_[A-Za-z0-9_-]{1,64}$/);

export function disputesRouter(deps: EvidenceDeps, opts: { adminToken: string }): Router {
  const router = Router();
  router.get("/orders/:id/evidence", requireAdmin(opts.adminToken), async (req, res) => {
    const id = OrderId.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      const pack = await buildEvidencePack(deps, id.data);
      res.set("cache-control", "no-store").json(pack);
    } catch (e) {
      if (e instanceof EvidenceError) return void res.status(404).json({ error: "NOT_FOUND" });
      throw e;
    }
  });
  return router;
}
