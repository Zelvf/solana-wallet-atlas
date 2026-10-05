import { NextRequest, NextResponse } from "next/server";
import bs58 from "bs58";
import type { ScanResponse, Transfer } from "@/lib/types";
import { InvalidRpcError, postCustomRpc, resolveCustomRpc, type CustomRpcTarget } from "@/lib/custom-rpc";
import { transfersFromTransaction } from "@/lib/transfer-parser";

export const runtime = "nodejs";
export const maxDuration = 60;


function validAddress(address: unknown): address is string {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return false;
  try { return bs58.decode(address).length === 32; } catch { return false; }
}

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

async function rpc<T>(method: string, params: unknown[], custom?: CustomRpcTarget): Promise<T> {
  const endpoint = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let status: number;
  let responseText: string;
  let contentType: string;
  let json: { result?: T; error?: { message?: string } };
  if (custom) {
    const result = await postCustomRpc(custom, body);
    status = result.status;
    responseText = result.text;
    contentType = result.contentType;
  } else {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    status = response.status;
    responseText = await response.text();
    contentType = response.headers.get("content-type") || "unknown content type";
  }
  const provider = custom ? "Custom RPC" : "Solana RPC";
  const preview = () => {
    let excerpt = responseText.replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
    if (custom) for (const secret of custom.url.searchParams.values()) if (secret) excerpt = excerpt.split(secret).join("[redacted]");
    return excerpt;
  };
  if (status === 429) throw new Error(`${provider} rate limit reached (HTTP 429). Retry shortly or check your provider's rate limits.`);
  if (status < 200 || status >= 300) {
    try {
      json = JSON.parse(responseText) as typeof json;
      if (json.error?.message) throw new Error(`${provider} returned HTTP ${status}: ${json.error.message}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${provider} returned HTTP`)) throw error;
    }
    throw new Error(`${provider} returned HTTP ${status} (${contentType}). ${preview() ? `Response: ${preview()}` : "No response body."}`);
  }
  try {
    json = JSON.parse(responseText) as typeof json;
  } catch {
    throw new Error(`${provider} returned a non-JSON response (HTTP ${status}; ${contentType}). ${preview() ? `Response: ${preview()}` : "Check that the endpoint URL and API key are correct."}`);
  }
  if (json.error) throw new Error(`${provider}: ${json.error.message || "request failed"}`);
  return json.result as T;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const address = body.address;
    if (!validAddress(address)) return NextResponse.json({ error: "Enter a valid Solana address." }, { status: 400 });
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return NextResponse.json({ error: "Activity limit must be between 1 and 500." }, { status: 400 });
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
    // Bound concurrent provider calls while keeping a 500-transaction scan within
    // the function time budget when the selected provider responds promptly.
    for (let index = 0; index < successful.length; index += 8) {
      const batch = successful.slice(index, index + 8);
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
