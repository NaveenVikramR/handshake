import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Handshake",
  description: "Payments for personal AI agents, approved with your passkey.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f8fafc" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
