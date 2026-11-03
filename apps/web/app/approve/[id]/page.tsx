"use client";
// Phone approval (docs/DESIGN.md): renders only the stored cart from GET /approvals/:id, exactly the
// payload the passkey signs; the badge comes from the trust registry. Nothing from the URL but the id.
import { use, useEffect, useState } from "react";
import { ApiError, assert, wallet } from "../../../lib/api";
import { approveLabel, countdown, money, reasonFor } from "../../../lib/ui";

interface Item {
  sku: string;
  name: string;
  qty: number;
  unitMinor: number;
}
interface Approval {
  id: string;
  expiresAt: number;
  cart: { items: Item[]; totalMinor: number; currency: string; shipToHash: string };
  merchant: { id: string; name: string | null; verified: boolean };
  shipTo?: { name: string; city: string; postalCode: string; country: string };
  options: unknown;
}

type View = { kind: "loading" } | { kind: "ready"; a: Approval } | { kind: "done" } | { kind: "blocked"; code: string };

export default function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [label, setLabel] = useState("Approve with passkey");

  useEffect(() => {
    setLabel(approveLabel(navigator.userAgent));
    wallet<Approval>(`approvals/${id}`)
      .then((a) => setView({ kind: "ready", a }))
      .catch((e: unknown) => setView({ kind: "blocked", code: e instanceof ApiError ? e.code : "INTERNAL" }));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [id]);

  async function approve(a: Approval) {
    setBusy(true);
    try {
      const response = await assert(a.options);
      await wallet(`approvals/${id}/verify`, { response });
      setView({ kind: "done" });
    } catch (e) {
      // A cancelled Face ID prompt isn't a failure: let them try again.
      if (e instanceof Error && e.name === "NotAllowedError") return setBusy(false);
      setView({ kind: "blocked", code: e instanceof ApiError ? e.code : "APPROVAL_INVALID" });
    }
  }

  if (view.kind === "loading") return <main className="narrow muted">Loading…</main>;
  if (view.kind === "done") {
    return (
      <main className="narrow" style={{ textAlign: "center" }}>
        <div className="big-icon ok">✓</div>
        <h1>Approved. Payment held until delivery.</h1>
        <p className="muted">You can close this page.</p>
      </main>
    );
  }
  if (view.kind === "blocked") {
    return (
      <main className="narrow" style={{ textAlign: "center" }}>
        <div className="big-icon bad">×</div>
        <h1>{reasonFor(view.code)}</h1>
        <p className="tooltip" title={view.code}>
          {view.code}
        </p>
      </main>
    );
  }

  const { a } = view;
  const left = a.expiresAt - now;
  const expired = left <= 0;
  return (
    <main className="narrow">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>{a.merchant.name ?? a.merchant.id}</h2>
          {a.merchant.verified ? <span className="badge ok">✓ Verified merchant</span> : null}
        </div>
        {!a.merchant.verified ? (
          <div className="banner bad" style={{ marginTop: 12 }}>
            Unverified merchant
          </div>
        ) : null}
      </div>

      <div className="card">
        {a.cart.items.map((i) => (
          <div className="row" key={i.sku} style={{ padding: "6px 0" }}>
            <div>
              <div>{i.name}</div>
              <div className="muted">
                {i.qty} × {money(i.unitMinor, a.cart.currency)}
              </div>
            </div>
            <div>{money(i.qty * i.unitMinor, a.cart.currency)}</div>
          </div>
        ))}
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 12 }}>
          <div className="muted">Total</div>
          <div className="total">{money(a.cart.totalMinor, a.cart.currency)}</div>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          Ship to:{" "}
          {a.shipTo
            ? `${a.shipTo.name}, ${a.shipTo.city} ${a.shipTo.postalCode}, ${a.shipTo.country}`
            : `the address in your spending permission (ref ${a.cart.shipToHash.slice(0, 8)})`}
        </div>
      </div>

      <p className="muted" style={{ textAlign: "center" }}>
        {expired ? "Approval expired" : `Expires in ${countdown(left)}`}
      </p>
      <button className="btn block" disabled={busy || expired} onClick={() => approve(a)}>
        {busy ? <span className="spinner" /> : label}
      </button>
    </main>
  );
}
