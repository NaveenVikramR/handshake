"use client";
// Landing page: the demo runs on free-tier services that sleep when idle, so wake the merchant and
// consumer first (about a minute from cold) and show progress, then open the wallet or dashboard.
import Link from "next/link";
import { useEffect, useState } from "react";

type State = "waking" | "up" | "down";
const SERVICES = [
  ["merchant", "Merchant agent"],
  ["consumer", "Your agent and wallet"],
] as const;
/** A cold start usually takes 30–90 s; the bar fills over this, then waits. */
const EXPECTED_S = 75;

async function wake(service: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`/api/wake/${service}`, { cache: "no-store" }).catch(() => undefined);
    if (r?.ok && ((await r.json()) as { up?: boolean }).up) return true;
  }
  return false;
}

export default function Home() {
  const [state, setState] = useState<Record<string, State>>({ merchant: "waking", consumer: "waking" });
  const [elapsed, setElapsed] = useState(0);
  const ready = Object.values(state).every((s) => s === "up");
  const failed = Object.values(state).some((s) => s === "down");

  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    for (const [s] of SERVICES) {
      void wake(s).then((up) => setState((p) => ({ ...p, [s]: up ? "up" : "down" })));
    }
    return () => clearInterval(t);
  }, []);

  const pct = ready ? 100 : Math.min(95, (elapsed / EXPECTED_S) * 100);
  return (
    <main className="narrow">
      <h1 style={{ marginTop: 32 }}>Handshake</h1>
      <p className="muted">Your AI agent shops; you approve with your passkey; PayPal moves the money.</p>

      <div className="card stack" style={{ marginTop: 24 }}>
        <div className="row">
          <strong>{ready ? "Ready" : failed ? "A service didn't wake up" : "Waking the demo…"}</strong>
          <span className="muted">{ready ? "" : `${elapsed}s`}</span>
        </div>
        <div className={`bar${failed ? " over" : ""}`} role="progressbar" aria-valuenow={Math.round(pct)}>
          <span style={{ width: `${pct}%`, transition: "width 0.5s linear" }} />
        </div>
        {SERVICES.map(([s, label]) => (
          <div className="row" key={s}>
            <span>{label}</span>
            <span className={`pill ${state[s] === "up" ? "ok" : state[s] === "down" ? "bad" : "warn"}`}>
              {state[s] === "up" ? "Awake" : state[s] === "down" ? "Not responding" : "Waking"}
            </span>
          </div>
        ))}
        {!ready && !failed ? (
          <p className="muted">Free hosting sleeps when idle; the first visit takes about a minute.</p>
        ) : null}
        {failed ? (
          <button className="btn secondary" onClick={() => window.location.reload()}>
            Try again
          </button>
        ) : null}
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        <Link className={`btn block${ready ? "" : " disabled"}`} href="/wallet" aria-disabled={!ready}>
          Open wallet
        </Link>
        <Link className={`btn block secondary${ready ? "" : " disabled"}`} href="/merchant" aria-disabled={!ready}>
          Merchant dashboard
        </Link>
      </div>
    </main>
  );
}
