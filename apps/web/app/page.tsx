import Link from "next/link";

export default function Home() {
  return (
    <main className="narrow">
      <h1 style={{ marginTop: 32 }}>Handshake</h1>
      <p className="muted">Your AI agent shops; you approve with your passkey; PayPal moves the money.</p>
      <div className="stack" style={{ marginTop: 24 }}>
        <Link className="btn block" href="/wallet">
          Open wallet
        </Link>
        <Link className="btn block secondary" href="/merchant">
          Merchant dashboard
        </Link>
      </div>
    </main>
  );
}
