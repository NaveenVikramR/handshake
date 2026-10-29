// Offer expiry job (SPEC §4.1): returns held stock once an offer's hold has passed.
import type { OfferStore } from "./store.js";

export const HOLD_EXPIRY_INTERVAL_MS = 30_000;

/** Runs `releaseExpired` on an interval, never overlapping itself. Returns a stop function. */
export function startHoldExpiry(
  store: OfferStore,
  now: () => number,
  opts: { intervalMs?: number; log?: (msg: string) => void } = {},
): () => void {
  const log = opts.log ?? ((msg) => console.error(msg));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await store.releaseExpired(now());
      if (n > 0) log(`hold expiry: released ${n} offer(s)`);
    } catch (e) {
      log(`hold expiry failed: ${e instanceof Error ? e.name : "unknown"}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? HOLD_EXPIRY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
