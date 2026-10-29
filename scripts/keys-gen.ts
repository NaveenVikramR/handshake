// `pnpm keys:gen`: prints fresh Ed25519 agent private keys to paste into the env. Writes no files.
import { generateEd25519KeyPair } from "../packages/core/src/index.js";

for (const role of ["MERCHANT", "CONSUMER"]) {
  const { privateKey } = generateEd25519KeyPair();
  console.log(`${role}_AGENT_PRIVATE_KEY=${privateKey}`);
}
console.log("# `pnpm db:seed` derives the public keys from these into the registry.");
