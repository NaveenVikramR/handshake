"use client";
// Merchant dashboard (docs/DESIGN.md): live feed of agent requests, each expanding to the 9 gate
// checks; PayPal state per order with fulfil/void/refund; shopkeeper assistant with confirm cards.
import { useCallback, useEffect, useState } from "react";
import { ApiError, merchant, readSSE } from "../../lib/api";
import { GATE_STEPS, money, orderPill, reasonFor } from "../../lib/ui";

interface Decision {
  step: string;
  result: string;
  reason: string;
}
interface Row {
  requestId: string;
  at: number;
  outcome: "allowed" | "step_up" | "blocked" | "pending";
  failedCode: string | null;
  decisions: Decision[];
  order: null | {
    orderId: string;
    status: string;
    path: string;
    totalMinor: number;
    currency: string;
    paypalOrderId: string | null;
    captureId: string | null;
    trackingNumber: string | null;
    awaitingPayPal: boolean;
  };
}
interface Proposal {
  action: "refund";
  orderId: string;
  totalMinor: number;
  currency: string;
}

const OUTCOME = {
  allowed: { label: "Allowed", tone: "ok" },
  step_up: { label: "Step-up", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  pending: { label: "Pending", tone: "warn" },
} as const;

function Login({ onIn }: { onIn: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState(false);
  return (
    <main className="narrow">
      <h1 style={{ marginTop: 32 }}>Merchant sign-in</h1>
      <div className="card stack">
        <label htmlFor="t">Admin token</label>
        <input id="t" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        <button
          className="btn block"
          onClick={async () => {
            const res = await fetch("/api/admin", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token }),
            });
            if (res.ok) onIn();
            else setErr(true);
          }}
        >
          Sign in
        </button>
        {err ? <div className="banner bad">That token isn&apos;t right.</div> : null}
      </div>
    </main>
  );
}

function Copy({ value }: { value: string }) {
  return (
    <button
      className="btn secondary mono"
      style={{ padding: "2px 8px" }}
      onClick={() => navigator.clipboard?.writeText(value)}
    >
      {value} ⧉
    </button>
  );
}

const ATTACKS = {
  amount: "Amount changed after approval",
  merchant: "Fake merchant agent",
  replay: "Replayed approval",
} as const;

export default function MerchantPage() {
  const [authed, setAuthed] = useState<boolean | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [demoReset, setDemoReset] = useState(false);
  const [demoNote, setDemoNote] = useState<string | null>(null);
  const [attacks, setAttacks] = useState<{ label: string; code: string; requestId?: string }[]>([]);
  const [attacking, setAttacking] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await merchant<{ requests: Row[]; demoMode?: boolean; demoReset?: boolean }>("dashboard/recent");
      setRows(r.requests);
      setDemo(Boolean(r.demoMode));
      setDemoReset(Boolean(r.demoReset));
      setAuthed(true);
    } catch (e) {
      setAuthed(e instanceof ApiError && e.status === 401 ? false : true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!authed) return;
    const ctrl = new AbortController();
    void (async () => {
      for (;;) {
        try {
          const res = await fetch("/api/m/dashboard/stream", { signal: ctrl.signal, cache: "no-store" });
          await readSSE(res, (ev, d) => {
            if (ev === "snapshot") setRows((d as { requests: Row[] }).requests);
          });
        } catch {
          if (ctrl.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => ctrl.abort();
  }, [authed]);

  async function act(path: string, body: unknown) {
    setNote(null);
    try {
      await merchant(path, body);
      await load();
    } catch (e) {
      setNote(e instanceof ApiError ? reasonFor(e.code) : "Action failed");
    }
  }

  /** DEMO_MODE: back to a clean shop (held authorizations are voided at PayPal first). */
  async function resetDemo() {
    if (!window.confirm("Reset the demo? This voids held payments and clears every order.")) return;
    setDemoNote(null);
    try {
      const r = await merchant<{ orders: number; voided: number }>("demo/reset", {});
      setDemoNote(`Demo reset: ${r.orders} orders cleared, ${r.voided} held payments voided`);
      await load();
    } catch {
      setDemoNote("Reset failed");
    }
  }

  /**
   * DEMO_MODE: replays PayPal's capture webhook for this order with a fixed event id. The first press
   * is recorded (never applied); the second shows the duplicate being ignored.
   */
  async function simulate(captureId: string) {
    setDemoNote(null);
    try {
      const r = await merchant<{ outcome: string }>("webhooks/paypal/simulate", {
        id: `WH-SIM-${captureId}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: captureId, status: "COMPLETED" },
      });
      setDemoNote(
        r.outcome === "duplicate"
          ? "Duplicate webhook ignored (same event id)"
          : "Simulated webhook recorded; the order is unchanged",
      );
    } catch {
      setDemoNote("Simulated webhook was refused");
    }
  }

  /**
   * DEMO_MODE attack demo (D28): the consumer agent sends a real tampered request to the live gate.
   * Each lands in Incoming requests as blocked; the panel shows the gate's answer too.
   */
  async function attack(kind: keyof typeof ATTACKS) {
    setAttacking(true);
    const label = ATTACKS[kind];
    try {
      const r = await merchant<{ code: string; requestId: string }>(`demo/attack/${kind}`, {});
      setAttacks((a) => [{ label, code: r.code, requestId: r.requestId }, ...a].slice(0, 6));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "INTERNAL";
      setAttacks((a) => [{ label, code: kind === "replay" && code === "APPROVAL_INVALID" ? "NO_PURCHASE_YET" : code }, ...a].slice(0, 6));
    } finally {
      setAttacking(false);
    }
  }

  async function ask() {
    setBusy(true);
    setReply(null);
    try {
      const r = await merchant<{ reply: string; proposals: Proposal[] }>("assistant", { message: q });
      setReply(r.reply);
      setProposals(r.proposals);
    } catch (e) {
      setReply(e instanceof ApiError ? "The assistant is unavailable right now." : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (authed === undefined) return <main className="page muted">Loading…</main>;
  if (!authed) return <Login onIn={load} />;

  return (
    <main className="page">
      <div className="row" style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Corner Grocery — agent payments</h1>
        <span className="muted">
          <span className="dot" /> Live
        </span>
        {demoReset ? (
          <button className="btn secondary" onClick={() => void resetDemo()}>
            Reset demo
          </button>
        ) : null}
      </div>
      {demoNote ? (
        <div className="banner" style={{ marginBottom: 16 }}>
          {demoNote}
        </div>
      ) : null}
      {note ? (
        <div className="banner bad" style={{ marginBottom: 16 }}>
          {note}
        </div>
      ) : null}
      <div className="grid2">
        <div className="card">
          <h2>Incoming requests</h2>
          {rows.length === 0 ? <p className="muted">Waiting for agents…</p> : null}
          {rows.map((r) => {
            const out = OUTCOME[r.outcome];
            const isOpen = open === r.requestId;
            return (
              <div key={r.requestId} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
                <div className="row" style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : r.requestId)}>
                  <span className="muted">{new Date(r.at).toLocaleTimeString()}</span>
                  <span className="mono">{r.requestId.slice(0, 12)}…</span>
                  <span>{r.order ? money(r.order.totalMinor, r.order.currency) : "—"}</span>
                  <span>
                    <span className={`pill ${out.tone}`}>{out.label}</span>
                  </span>
                </div>
                {r.failedCode ? (
                  <div
                    className={r.outcome === "step_up" ? "muted" : ""}
                    style={{ color: r.outcome === "blocked" ? "var(--bad)" : undefined }}
                  >
                    {reasonFor(r.failedCode)} <span className="tooltip">{r.failedCode}</span>
                  </div>
                ) : null}
                {isOpen ? (
                  <table style={{ marginTop: 8 }}>
                    <tbody>
                      {r.decisions.map((d, i) => (
                        <tr key={i} style={d.result === "fail" ? { background: "#fef2f2" } : undefined}>
                          <td>
                            <span className={`check ${d.result === "fail" ? "fail" : "pass"}`}>
                              {d.result === "fail" ? "✗" : "✓"}
                            </span>
                          </td>
                          <td>{GATE_STEPS[d.step] ?? `Step ${d.step}`}</td>
                          <td className="muted">
                            {d.result === "fail" ? reasonFor(d.reason.split(":")[0]) : d.reason}
                            {d.result === "fail" ? <span className="tooltip"> {d.reason.split(":")[0]}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            );
          })}
        </div>

        <div>
          {demo ? (
            <div className="card stack">
              <h2>Attack demo</h2>
              <p className="muted">Real tampered requests from the agent to the live gate.</p>
              <div className="row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "flex-start" }}>
                {(Object.keys(ATTACKS) as (keyof typeof ATTACKS)[]).map((k) => (
                  <button key={k} className="btn danger" disabled={attacking} onClick={() => void attack(k)}>
                    {ATTACKS[k]}
                  </button>
                ))}
              </div>
              {attacks.map((a, i) => (
                <div key={a.requestId ?? i} className="banner bad">
                  <strong>{a.label}</strong>:{" "}
                  {a.code === "OK"
                    ? "the gate let it through"
                    : a.code === "NO_PURCHASE_YET"
                      ? "make one approved purchase first, then replay it"
                      : `blocked. ${reasonFor(a.code)}`}{" "}
                  <span className="tooltip">{a.code}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="card">
            <h2>PayPal</h2>
            {rows.filter((r) => r.order).length === 0 ? <p className="muted">No orders yet.</p> : null}
            {rows
              .filter((r) => r.order)
              .map((r) => {
                const o = r.order!;
                const p = orderPill(o.status, o.awaitingPayPal);
                return (
                  <div
                    key={o.orderId}
                    className="stack"
                    style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}
                  >
                    <div className="row">
                      <strong>{money(o.totalMinor, o.currency)}</strong>
                      <span className={`pill ${p.tone}`}>{p.label}</span>
                    </div>
                    {o.paypalOrderId ? (
                      <div className="muted">
                        Order <Copy value={o.paypalOrderId} />
                      </div>
                    ) : null}
                    {o.captureId ? (
                      <div className="muted">
                        Capture <Copy value={o.captureId} />
                      </div>
                    ) : null}
                    {demo && o.captureId ? (
                      <div className="row">
                        <button className="btn secondary" onClick={() => void simulate(o.captureId!)}>
                          Simulate webhook
                        </button>
                      </div>
                    ) : null}
                    {o.status === "authorized" ? (
                      <div className="row">
                        <button
                          className="btn"
                          onClick={() =>
                            act(`orders/${o.orderId}/fulfil`, { fulfilled: true, trackingNumber: `HS${Date.now()}` })
                          }
                        >
                          Fulfil & capture
                        </button>
                        <button
                          className="btn danger"
                          onClick={() => act(`orders/${o.orderId}/fulfil`, { fulfilled: false })}
                        >
                          Void
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>

          <div className="card stack">
            <h2>Shopkeeper assistant</h2>
            <textarea
              rows={2}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Why was the last request blocked?"
            />
            <button className="btn" disabled={busy || !q.trim()} onClick={ask}>
              {busy ? <span className="spinner" /> : "Ask"}
            </button>
            {reply ? <p>{reply}</p> : null}
            {proposals.map((p) => (
              <div key={p.orderId} className="banner warn">
                <div className="row">
                  <span>
                    Refund {money(p.totalMinor, p.currency)} for order{" "}
                    <span className="mono">{p.orderId.slice(0, 12)}…</span>?
                  </span>
                  <button
                    className="btn"
                    onClick={async () => {
                      await act(`orders/${p.orderId}/refund`, {});
                      setProposals((ps) => ps.filter((x) => x.orderId !== p.orderId));
                    }}
                  >
                    Confirm
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
