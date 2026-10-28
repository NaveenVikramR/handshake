// The only place minor units become a PayPal decimal string (2-decimal currencies only for now).
export function toPayPalValue(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error(`invalid amount in minor units: ${minor}`);
  const major = Math.trunc(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${major}.${cents}`;
}
