import { NextRequest, NextResponse } from "next/server";
import bs58 from "bs58";
import type { ScanResponse, Transfer } from "@/lib/types";
import { InvalidRpcError, postCustomRpc, resolveCustomRpc, type CustomRpcTarget } from "@/lib/custom-rpc";
import { transfersFromTransaction } from "@/lib/transfer-parser";

export const runtime = "nodejs";
export const maxDuration = 30;


function validAddress(address: unknown): address is string {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return false;
  try { return bs58.decode(address).length === 32; } catch { return false; }
}

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

async function rpc<T>(method: string, params: unknown[], custom?: CustomRpcTarget): Promise<T> {
  const endpoint = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let status: number;
  let json: { result?: T; error?: { message?: string } };
  if (custom) {
    const result = await postCustomRpc(custom, body);
    status = result.status;
    json = result.json as typeof json;
  } else {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    status = response.status;
    json = await response.json();
  }
  if (status === 429) throw new Error("The Solana RPC rate limit was reached. Retry shortly or choose another RPC endpoint.");
  if (status < 200 || status >= 300) throw new Error(`Solana RPC returned HTTP ${status}.`);
  if (json.error) throw new Error(`Solana RPC: ${json.error.message || "request failed"}`);
  return json.result as T;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const address = body.address;
    if (!validAddress(address)) return NextResponse.json({ error: "Enter a valid Solana address." }, { status: 400 });
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) return NextResponse.json({ error: "Activity limit must be between 1 and 25." }, { status: 400 });
    if (body.excludeTrades !== undefined && typeof body.excludeTrades !== "boolean") return NextResponse.json({ error: "excludeTrades must be true or false." }, { status: 400 });
    const excludeTrades = body.excludeTrades !== false;
    const custom = body.rpcUrl === undefined ? undefined : await resolveCustomRpc(body.rpcUrl);
    if (custom && await rpc<string>("getGenesisHash", [], custom) !== MAINNET_GENESIS_HASH) {
      throw new InvalidRpcError("This RPC is not connected to Solana mainnet.");
    }

    const signatures = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [address, { limit, commitment: "confirmed" }], custom);
    const successful = signatures.filter((item) => !item.err);
    const results: Transfer[] = [];
    let tradeTransactionsExcluded = 0;
    // Keep RPC demand modest, especially on the public endpoint.
    for (let index = 0; index < successful.length; index += 3) {
      const batch = successful.slice(index, index + 3);
      const transactions = await Promise.all(batch.map(async (item) => {
        const tx = await rpc<Parameters<typeof transfersFromTransaction>[0]>("getTransaction", [item.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }], custom);
        const parsed = transfersFromTransaction(tx, item.signature, address);
        return excludeTrades && parsed.tradeLike ? { transfers: [], tradeLike: true } : parsed;
      }));
      for (const transaction of transactions) {
        if (transaction.tradeLike && excludeTrades) tradeTransactionsExcluded++;
        results.push(...transaction.transfers);
      }
    }
    const payload: ScanResponse = {
      address,
      transfers: results,
      signaturesChecked: signatures.length,
      hasMoreHistory: signatures.length === limit,
      tradeTransactionsExcluded,
      rpc: custom ? "custom" : process.env.SOLANA_RPC_URL ? "configured" : "public",
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed.";
    return NextResponse.json({ error: message }, { status: error instanceof InvalidRpcError ? 400 : 502 });
  }
}
