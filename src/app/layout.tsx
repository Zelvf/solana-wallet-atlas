import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wallet Atlas | Solana transfer graph",
  description: "Explore observed SOL and SPL token transfer connections between Solana addresses.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
