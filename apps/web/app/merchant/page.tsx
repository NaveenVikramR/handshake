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

export default function MerchantPage() {
  const [authed, setAuthed] = useState<boolean | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await merchant<{ requests: Row[] }>("dashboard/recent");
      setRows(r.requests);
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
      </div>
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
