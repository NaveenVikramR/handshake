// Passkey registration (SPEC §5.1 step 1). Registration only ever creates a new user:
// adding a passkey to an existing user would need that user signed in, which the wallet
// doesn't have yet, so it is refused rather than allowing account takeover (D16).
import { randomBytes } from "node:crypto";
import { b64urlEncode } from "@handshake/core";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import express, { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";

const REGISTRATION_TTL_MS = 5 * 60_000;

const OptionsBody = z.strictObject({ displayName: z.string().trim().min(1).max(64) });
const VerifyBody = z.object({
  userId: z.string().regex(/^usr_[A-Za-z0-9_-]{22}$/),
  response: z
    .object({
      id: z.string().min(1).max(1024),
      rawId: z.string().min(1).max(1024),
      type: z.literal("public-key"),
      response: z.object({ clientDataJSON: z.string().max(8192), attestationObject: z.string().max(16384) }).loose(),
      clientExtensionResults: z.object({}).loose(),
    })
    .loose(),
});

export function passkeyRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(express.json({ limit: "32kb" }));

  router.post("/passkeys/register/options", async (req, res) => {
    const body = OptionsBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });

    const userId = `usr_${b64urlEncode(randomBytes(16))}`;
    await ctx.store.createUser({ id: userId, displayName: body.data.displayName });
    const options = await generateRegistrationOptions({
      rpName: ctx.webauthn.rpName,
      rpID: ctx.webauthn.rpId,
      userName: body.data.displayName,
      userID: new TextEncoder().encode(userId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    await ctx.store.putRegistrationChallenge(userId, options.challenge, ctx.now() + REGISTRATION_TTL_MS);
    res.json({ userId, options });
  });

  router.post("/passkeys/register/verify", async (req, res) => {
    const body = VerifyBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    const { userId, response } = body.data;

    // Taken (and deleted) first, so a challenge can be tried once.
    const expectedChallenge = await ctx.store.takeRegistrationChallenge(userId, ctx.now());
    if (!expectedChallenge) return void res.status(400).json({ error: "REGISTRATION_EXPIRED" });
    if (await ctx.store.hasCredentials(userId)) return void res.status(409).json({ error: "ALREADY_REGISTERED" });

    let info;
    try {
      const result = await verifyRegistrationResponse({
        response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge,
        expectedOrigin: ctx.webauthn.origin,
        expectedRPID: ctx.webauthn.rpId,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) throw new Error("not verified");
      info = result.registrationInfo;
    } catch {
      return void res.status(400).json({ error: "REGISTRATION_INVALID" });
    }
    if (!info.userVerified) return void res.status(400).json({ error: "APPROVAL_UV_MISSING" });

    const added = await ctx.store.addCredential({
      credentialId: info.credential.id,
      userId,
      publicKey: b64urlEncode(info.credential.publicKey),
      transports: info.credential.transports ?? [],
    });
    if (added === "exists") return void res.status(409).json({ error: "ALREADY_REGISTERED" });
    res.json({ userId, credentialId: info.credential.id });
  });

  return router;
}
