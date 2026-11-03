"use client";
// Wallet (docs/DESIGN.md): passkey, saved PayPal account, mandates as limit bars, activity, and the
// chat with the shopping agent. A new mandate is approved from the server's stored copy.
import { useCallback, useEffect, useState } from "react";
import { ApiError, assert, readSSE, register, savedUserId, signIn, wallet } from "../../lib/api";
import { WAITING_FOR_PAYPAL, money, orderPill, reasonFor } from "../../lib/ui";

interface Me {
  userId: string;
  displayName: string;
  passkeys: { id: string; transports: string[] }[];
  paypal: { status: "pending" | "confirmed"; payerEmail: string | null } | null;
}
interface MandateRow {
  mandateId: string;
  status: string;
  scope: { merchants: { id: string; name: string | null }[]; categories: string[] };
  limits: { perOrderMinor: number; periodMinor: number; period: string };
  spentMinor: number;
  exp: number;
}
interface Activity {
  orderId: string;
  merchantName: string | null;
  totalMinor: number;
  currency: string;
  status: string;
  createdAt: number;
}
interface ShipTo {
  name: string;
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}
type ChatLine = { kind: "info" | "approve" | "paypal" | "receipt" | "agent" | "error"; text: string; href?: string };

const ADDR_KEY = "hs_shipto";
const blankAddr: ShipTo = { name: "", line1: "", city: "", postalCode: "", country: "US" };

function loadAddr(): ShipTo {
  try {
    return { ...blankAddr, ...(JSON.parse(localStorage.getItem(ADDR_KEY) ?? "{}") as Partial<ShipTo>) };
  } catch {
    return blankAddr;
  }
}

function Bar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = Math.min(100, limit > 0 ? (used / limit) * 100 : 0);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row muted">
        <span>{label}</span>
        <span>
          {money(used)} of {money(limit)}
        </span>
      </div>
      <div className={`bar${pct >= 100 ? " over" : ""}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SignedOut({ onIn }: { onIn: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const known = typeof window === "undefined" ? null : savedUserId();
  const run = async (f: () => Promise<unknown>) => {
    setErr(null);
    try {
      await f();
      onIn();
    } catch (e) {
      setErr(e instanceof ApiError ? reasonFor(e.code) : "Passkey was cancelled or isn't available here");
    }
  };
  return (
    <main className="narrow">
      <h1 style={{ marginTop: 32 }}>Your Handshake wallet</h1>
      {known ? (
        <div className="card stack">
          <p>Welcome back.</p>
          <button className="btn block" onClick={() => run(() => signIn(known))}>
            Sign in with passkey
          </button>
        </div>
      ) : null}
      <div className="card stack">
        <label htmlFor="name">{known ? "Or create a new wallet" : "Create your wallet"}</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        <button
          className="btn block"
          disabled={!name.trim()}
          onClick={() =>
            run(async () => {
              const id = await register(name.trim());
              await signIn(id);
            })
          }
        >
          Create passkey
        </button>
      </div>
      {err ? <div className="banner bad">{err}</div> : null}
    </main>
  );
}

export default function WalletPage() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [mandates, setMandates] = useState<MandateRow[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [addr, setAddr] = useState<ShipTo>(blankAddr);
  const [msg, setMsg] = useState("buy 1 rice");
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState({ categories: "grocery", perOrder: "30", weekly: "80", days: "7" });

  const refresh = useCallback(async () => {
    try {
      const m = await wallet<Me>("me");
      setMe(m);
      const [md, act] = await Promise.all([
        wallet<{ mandates: MandateRow[] }>("mandates"),
        wallet<{ activity: Activity[] }>("activity"),
      ]);
      setMandates(md.mandates);
      setActivity(act.activity);
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    setAddr(loadAddr());
    void refresh();
  }, [refresh]);

  const saveAddr = (a: ShipTo) => {
    setAddr(a);
    try {
      localStorage.setItem(ADDR_KEY, JSON.stringify(a));
    } catch {
      // not persisted; still used for this session
    }
  };
  const addrOk = addr.name && addr.line1 && addr.city && addr.postalCode && /^[A-Z]{2}$/.test(addr.country);

  async function confirmPayPal() {
    setNote(null);
    try {
      const r = await wallet<{ status: string; linkId?: string; options?: unknown }>("wallet/paypal");
      if (r.status !== "pending" || !r.linkId) return refresh();
      const response = await assert(r.options);
      await wallet("wallet/paypal/confirm", { linkId: r.linkId, response });
      await refresh();
    } catch (e) {
      setNote(e instanceof ApiError ? reasonFor(e.code) : "Passkey was cancelled");
    }
  }

  async function createMandate() {
    setNote(null);
    try {
      const { mandateId } = await wallet<{ mandateId: string }>("mandates/options", {
        merchants: ["mer_corner"],
        categories: form.categories
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
        perOrderMinor: Math.round(Number(form.perOrder) * 100),
        periodMinor: Math.round(Number(form.weekly) * 100),
        period: "week",
        shipTo: addr,
        days: Number(form.days),
      });
      // Approve what the server stored, not what this form drew.
      const stored = await wallet<{
        mandate: { limits: MandateRow["limits"] };
        merchants: { name: string | null }[];
        options: unknown;
      }>(`mandates/${mandateId}`);
      const ok = window.confirm(
        `Allow your agent to spend up to ${money(stored.mandate.limits.perOrderMinor)} per order and ${money(
          stored.mandate.limits.periodMinor,
        )} per week at ${stored.merchants.map((m) => m.name).join(", ")}?`,
      );
      if (!ok) return;
      const response = await assert(stored.options);
      await wallet("mandates/verify", { mandateId, response });
      await refresh();
    } catch (e) {
      setNote(e instanceof ApiError ? reasonFor(e.code) : "Passkey was cancelled");
    }
  }

  async function revoke(id: string) {
    await wallet(`mandates/${id}/revoke`, {});
    await refresh();
  }

  async function send() {
    setBusy(true);
    setChat([{ kind: "info", text: `You: ${msg}` }]);
    const push = (l: ChatLine) => setChat((c) => [...c, l]);
    try {
      const res = await fetch("/api/c/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg, ...(addrOk ? { shipTo: addr } : {}) }),
      });
      if (!res.ok) {
        push({ kind: "error", text: reasonFor(((await res.json().catch(() => ({}))) as { error?: string }).error) });
        return;
      }
      await readSSE(res, (_ev, d) => {
        const e = d as Record<string, unknown>;
        if (e.type === "tool") push({ kind: "info", text: `Agent: ${String(e.name).replaceAll("_", " ")}` });
        if (e.type === "tool_result" && !e.ok) push({ kind: "error", text: reasonFor(String(e.error)) });
        if (e.type === "path")
          push({
            kind: "info",
            text: e.path === "mandate" ? "Covered by your spending permission" : "Needs your approval",
          });
        if (e.type === "approval_required")
          push({ kind: "approve", text: "Approve on your phone", href: String(e.url) });
        if (e.type === "paypal_approval_required")
          push({ kind: "paypal", text: WAITING_FOR_PAYPAL, href: String(e.url) });
        if (e.type === "receipt") {
          const r = e.receipt as { status: string };
          push({
            kind: "receipt",
            text: `${orderPill(r.status).label}: ${money(Number(e.totalMinor), String(e.currency))}`,
          });
        }
        if (e.type === "message") push({ kind: "agent", text: String(e.text) });
        if (e.type === "error") push({ kind: "error", text: reasonFor(String(e.error)) });
      });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  if (me === undefined) return <main className="narrow muted">Loading…</main>;
  if (me === null) return <SignedOut onIn={refresh} />;

  return (
    <main className="page">
      <div className="row" style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{me.displayName}&apos;s wallet</h1>
        <button
          className="btn secondary"
          onClick={async () => {
            await wallet("logout", {});
            setMe(null);
          }}
        >
          Sign out
        </button>
      </div>
      {note ? (
        <div className="banner bad" style={{ marginBottom: 16 }}>
          {note}
        </div>
      ) : null}
      <div className="grid2">
        <div>
          <div className="card stack">
            <h2>Ask your agent</h2>
            <textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} />
            <button className="btn" disabled={busy || !msg.trim()} onClick={send}>
              {busy ? <span className="spinner" /> : "Send"}
            </button>
            {chat.map((l, i) => (
              <div key={i} className={l.kind === "error" ? "banner bad" : l.kind === "paypal" ? "banner warn" : ""}>
                {l.href ? (
                  <div className="row">
                    <span>{l.text}</span>
                    <a className="btn secondary" href={l.href} target="_blank" rel="noreferrer">
                      {l.kind === "paypal" ? "Open PayPal" : "Open approval"}
                    </a>
                  </div>
                ) : (
                  <span className={l.kind === "info" ? "muted" : ""}>{l.text}</span>
                )}
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Activity</h2>
            {activity.length === 0 ? <p className="muted">No orders yet.</p> : null}
            <table>
              <tbody>
                {activity.map((a) => {
                  const p = orderPill(a.status);
                  return (
                    <tr key={a.orderId}>
                      <td>{a.merchantName ?? "Merchant"}</td>
                      <td>{money(a.totalMinor, a.currency)}</td>
                      <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                      <td>
                        <span className={`pill ${p.tone}`}>{p.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Passkey</h2>
            {me.passkeys.map((p) => (
              <div className="row" key={p.id}>
                <span>
                  <span className="dot" /> Passkey {p.id}…
                </span>
                <span className="muted">{p.transports.join(", ") || "this device"}</span>
              </div>
            ))}
          </div>

          <div className="card stack">
            <h2>PayPal</h2>
            {!me.paypal ? <p className="muted">Saved after your first PayPal approval.</p> : null}
            {me.paypal?.status === "pending" ? (
              <>
                <p>
                  Confirm <strong>{me.paypal.payerEmail ?? "this PayPal account"}</strong> for agent payments?
                </p>
                <button className="btn block" onClick={confirmPayPal}>
                  Confirm with passkey
                </button>
              </>
            ) : null}
            {me.paypal?.status === "confirmed" ? (
              <p>
                <span className="pill ok">Confirmed</span> {me.paypal.payerEmail}
              </p>
            ) : null}
          </div>

          <div className="card">
            <h2>Spending permissions</h2>
            {mandates
              .filter((m) => m.status !== "pending")
              .map((m) => (
                <div key={m.mandateId} className="card">
                  <div className="row">
                    <strong>{m.scope.merchants.map((x) => x.name ?? x.id).join(", ")}</strong>
                    {m.status === "active" ? (
                      <button className="btn danger" onClick={() => revoke(m.mandateId)}>
                        Revoke
                      </button>
                    ) : (
                      <span className="pill grey">Revoked</span>
                    )}
                  </div>
                  <div className="muted">{m.scope.categories.join(", ")}</div>
                  <Bar used={0} limit={m.limits.perOrderMinor} label="Per order" />
                  <Bar used={m.spentMinor} limit={m.limits.periodMinor} label={`This ${m.limits.period}`} />
                </div>
              ))}
            <details>
              <summary>New permission</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <label>Categories</label>
                <input value={form.categories} onChange={(e) => setForm({ ...form, categories: e.target.value })} />
                <label>Per order ($)</label>
                <input
                  value={form.perOrder}
                  inputMode="decimal"
                  onChange={(e) => setForm({ ...form, perOrder: e.target.value })}
                />
                <label>Per week ($)</label>
                <input
                  value={form.weekly}
                  inputMode="decimal"
                  onChange={(e) => setForm({ ...form, weekly: e.target.value })}
                />
                <label>Days</label>
                <input
                  value={form.days}
                  inputMode="numeric"
                  onChange={(e) => setForm({ ...form, days: e.target.value })}
                />
                <button className="btn" disabled={!addrOk} onClick={createMandate}>
                  Approve with passkey
                </button>
                {!addrOk ? <p className="muted">Add a delivery address first.</p> : null}
              </div>
            </details>
          </div>

          <div className="card stack">
            <h2>Delivery address</h2>
            {(["name", "line1", "city", "postalCode", "country"] as const).map((k) => (
              <input
                key={k}
                placeholder={k}
                value={addr[k]}
                onChange={(e) => saveAddr({ ...addr, [k]: e.target.value })}
              />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
