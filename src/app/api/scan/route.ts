import { NextRequest, NextResponse } from "next/server";
import bs58 from "bs58";
import type { ScanResponse, Transfer } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

type ParsedInstruction = { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } };
type TokenBalance = { accountIndex: number; owner?: string };
type ParsedTransaction = {
  blockTime: number | null;
  meta?: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { instructions: ParsedInstruction[] }[];
  };
  transaction: { message: { accountKeys: { pubkey: string }[]; instructions: ParsedInstruction[] } };
};

function validAddress(address: unknown): address is string {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return false;
  try { return bs58.decode(address).length === 32; } catch { return false; }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const endpoint = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 429) throw new Error("The Solana RPC rate limit was reached. Retry shortly or configure a private RPC endpoint.");
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}.`);
  const json = await response.json();
  if (json.error) throw new Error(`Solana RPC: ${json.error.message || "request failed"}`);
  return json.result as T;
}

function transfersFromTransaction(tx: ParsedTransaction | null, signature: string, address: string): Transfer[] {
  if (!tx?.meta || tx.meta.err) return [];
  const keys = tx.transaction.message.accountKeys.map((item) => item.pubkey);
  const owners = new Map<string, string>();
  for (const balance of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    if (balance.owner && keys[balance.accountIndex]) owners.set(keys[balance.accountIndex], balance.owner);
  }
  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions || []).flatMap((item) => item.instructions),
  ];
  const found: Transfer[] = [];
  for (const instruction of instructions) {
    const parsed = instruction.parsed;
    if (!parsed || !["transfer", "transferChecked"].includes(parsed.type || "")) continue;
    const info = parsed.info || {};
    let source: string | undefined;
    let target: string | undefined;
    let amount: string | undefined;
    let decimals = 9;
    let asset = "SOL";
    if (instruction.program === "system" && parsed.type === "transfer") {
      source = info.source as string;
      target = info.destination as string;
      amount = String(info.lamports ?? "");
    } else if (instruction.program === "spl-token" || instruction.program === "spl-token-2022") {
      source = owners.get(String(info.source));
      target = owners.get(String(info.destination));
      amount = String((info.tokenAmount as { amount?: string } | undefined)?.amount ?? info.amount ?? "");
      decimals = Number((info.tokenAmount as { decimals?: number } | undefined)?.decimals ?? 0);
      asset = String(info.mint || "SPL token");
    }
    if (!source || !target || source === target || !amount || !/^\d+$/.test(amount) || !/[1-9]/.test(amount)) continue;
    if (source !== address && target !== address) continue;
    found.push({ source, target, signature, asset, amount, decimals, blockTime: tx.blockTime });
  }
  return found;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const address = body.address;
    if (!validAddress(address)) return NextResponse.json({ error: "Enter a valid Solana address." }, { status: 400 });
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) return NextResponse.json({ error: "Activity limit must be between 1 and 25." }, { status: 400 });

    const signatures = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [address, { limit, commitment: "confirmed" }]);
    const successful = signatures.filter((item) => !item.err);
    const results: Transfer[] = [];
    // Keep RPC demand modest, especially on the public endpoint.
    for (let index = 0; index < successful.length; index += 3) {
      const batch = successful.slice(index, index + 3);
      const transactions = await Promise.all(batch.map(async (item) => {
        const tx = await rpc<ParsedTransaction | null>("getTransaction", [item.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
        return transfersFromTransaction(tx, item.signature, address);
      }));
      results.push(...transactions.flat());
    }
    const payload: ScanResponse = {
      address,
      transfers: results,
      signaturesChecked: signatures.length,
      hasMoreHistory: signatures.length === limit,
      rpc: process.env.SOLANA_RPC_URL ? "configured" : "public",
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
