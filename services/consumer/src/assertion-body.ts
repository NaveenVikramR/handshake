// The AuthenticationResponseJSON a browser posts after navigator.credentials.get(), reduced to
// the fields we verify. Shared by approval and mandate verification.
import type { WebAuthnAssertion } from "@handshake/core";
import { z } from "zod";

const b64 = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[A-Za-z0-9_-]+$/);

const AuthenticationResponse = z
  .object({
    id: b64,
    rawId: b64,
    type: z.literal("public-key"),
    response: z.object({ clientDataJSON: b64, authenticatorData: b64, signature: b64 }).loose(),
  })
  .loose()
  .refine((r) => r.id === r.rawId, "id must equal rawId");

/** Parses `{ response }` from a request body; undefined if malformed. */
export function parseAssertionBody(body: unknown): WebAuthnAssertion | undefined {
  const parsed = z.object({ response: AuthenticationResponse }).safeParse(body);
  if (!parsed.success) return undefined;
  const r = parsed.data.response;
  return {
    credentialId: r.id,
    authenticatorData: r.response.authenticatorData,
    clientDataJSON: r.response.clientDataJSON,
    signature: r.response.signature,
  };
}
