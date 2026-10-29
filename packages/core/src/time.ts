// SPEC §3: payloads carry iat/exp in unix seconds; 60 s clock skew tolerance.
export const CLOCK_SKEW_S = 60;

export type Freshness = "ok" | "expired" | "not_yet_valid";

/** `now` is unix seconds, passed in by the caller (core reads no clocks). */
export function checkFreshness(p: { iat: number; exp: number }, now: number): Freshness {
  if (!Number.isFinite(now) || !Number.isInteger(p.iat) || !Number.isInteger(p.exp)) {
    return "expired";
  }
  if (p.iat > now + CLOCK_SKEW_S) return "not_yet_valid";
  if (p.exp + CLOCK_SKEW_S < now) return "expired";
  return "ok";
}
