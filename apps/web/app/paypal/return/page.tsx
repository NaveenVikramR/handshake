"use client";
// PayPal sends the buyer back here with ?r=<return secret>&token=<PayPal order id>. We ask the
// merchant to finish; only the status comes back (no request id or receipt in the URL or the page).
// `r` proves this browser is the one that approved on PayPal (D31).
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { merchant } from "../../../lib/api";
import { WAITING_FOR_PAYPAL, orderPill } from "../../../lib/ui";

function Return() {
  const params = useSearchParams();
  const token = params.get("token");
  const r = params.get("r");
  const [status, setStatus] = useState<string>("loading");
  useEffect(() => {
    if (!token) return setStatus("unknown");
    merchant<{ status: string }>("paypal/return", { token, ...(r ? { r } : {}) })
      .then((r) => setStatus(r.status))
      .catch(() => setStatus("failed"));
  }, [token, r]);

  if (status === "loading") return <p className="muted">Finishing with PayPal…</p>;
  if (status === "authorized" || status === "captured") {
    return (
      <>
        <div className="big-icon ok">✓</div>
        <h1>PayPal approved. Payment {orderPill(status).label.toLowerCase()} until delivery.</h1>
        <p className="muted">Your agent will pick this up. You can close this page.</p>
      </>
    );
  }
  if (status === "payer_action_required") return <div className="banner warn">{WAITING_FOR_PAYPAL}</div>;
  return (
    <>
      <div className="big-icon bad">×</div>
      <h1>PayPal couldn&apos;t process this payment</h1>
    </>
  );
}

export default function PayPalReturn() {
  return (
    <main className="narrow" style={{ textAlign: "center" }}>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Return />
      </Suspense>
    </main>
  );
}
