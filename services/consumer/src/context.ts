import type { Planner } from "./agent/planner.js";
import type { WalletStore } from "./store.js";

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  /** The wallet web app's origin, where the browser runs the ceremony. */
  origin: string;
}

/** The consumer agent (M6). Absent in tests that only exercise passkeys, approvals and mandates. */
export interface AgentConfig {
  /** CONSUMER_AGENT_PRIVATE_KEY (Ed25519 PKCS8, base64url): signs offer and payment requests. */
  privateKey: string;
  /** Merchants the agent may contact. The LLM picks among these; it never supplies a URL. */
  merchantUrls: string[];
  /** Wallet web app origin; the phone approval page is `${webUrl}/approve/:id`. */
  webUrl: string;
  /** Period spend so far (D17 ledger, read-only here). */
  spent(key: { mandateId: string; periodStart: number }): Promise<number>;
  planner: Planner;
  fetch?: typeof fetch;
  /** How often a step-up waits re-reads the approval; tests shorten it. */
  approvalPollMs?: number;
}

export interface AppContext {
  store: WalletStore;
  webauthn: WebAuthnConfig;
  /** This wallet's consumer agent; mandates are issued to it. */
  consumerAgentId: string;
  /** ms since epoch; injected in tests. */
  now: () => number;
  agent?: AgentConfig;
}
