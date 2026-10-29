import type { WalletStore } from "./store.js";

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  /** The wallet web app's origin, where the browser runs the ceremony. */
  origin: string;
}

export interface AppContext {
  store: WalletStore;
  webauthn: WebAuthnConfig;
  /** This wallet's consumer agent; mandates are issued to it. */
  consumerAgentId: string;
  /** ms since epoch; injected in tests. */
  now: () => number;
}
