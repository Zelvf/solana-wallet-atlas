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

async function rpcPayload(body: string, custom?: CustomRpcTarget, operation = "request"): Promise<unknown> {
  const endpoint = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  let status: number;
  let responseText: string;
  let contentType: string;
  let json: unknown;
  let retryAfter: string | undefined;
  for (let attempt = 0; ; attempt++) {
    if (custom) {
      const response = await postCustomRpc(custom, body);
      status = response.status;
      responseText = response.text;
      contentType = response.contentType;
      retryAfter = response.retryAfter;
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
      retryAfter = response.headers.get("retry-after") || undefined;
    }
    if ((status !== 429 && status !== 503) || attempt >= 3) break;
    const retrySeconds = Number(retryAfter);
    const retryDate = retryAfter ? Date.parse(retryAfter) : NaN;
    const headerDelay = Number.isFinite(retrySeconds) && retrySeconds >= 0
      ? retrySeconds * 1000
      : Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : 0;
    const backoff = Math.min(8000, 1000 * (2 ** attempt));
    const delay = Math.min(10000, headerDelay || backoff) + Math.round(Math.random() * 300);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const provider = custom ? "Custom RPC" : "Solana RPC";
  const preview = () => {
    let excerpt = responseText.replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
    if (custom) for (const secret of custom.url.searchParams.values()) if (secret) excerpt = excerpt.split(secret).join("[redacted]");
    return excerpt;
  };
  if (status === 429) throw new Error(`${provider} ${operation} rate limit remained after 3 retries (HTTP 429)${retryAfter ? `; provider Retry-After: ${retryAfter}` : ""}. Reduce transactions per address, wait for the quota window, or check your Helius plan limits.`);
  if (status === 503) throw new Error(`${provider} ${operation} is temporarily unavailable (HTTP 503) after 3 retries. Try again shortly.`);
  if (status < 200 || status >= 300) {
    try {
      const errorMessage = getRpcError(JSON.parse(responseText));
      if (errorMessage) throw new Error(`${provider} returned HTTP ${status}: ${errorMessage}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${provider} returned HTTP`)) throw error;
    }
    throw new Error(`${provider} returned HTTP ${status} (${contentType}). ${preview() ? `Response: ${preview()}` : "No response body."}`);
  }
  try {
    json = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(`${provider} returned a non-JSON response (HTTP ${status}; ${contentType}). ${preview() ? `Response: ${preview()}` : "Check that the endpoint URL and API key are correct."}`);
  }
  return json;
}

function getRpcError(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value) || !value.error) return null;
  const error = value.error;
  return typeof error === "object" && error && "message" in error && typeof error.message === "string"
    ? error.message
    : "request failed";
}

async function rpc<T>(method: string, params: unknown[], custom?: CustomRpcTarget): Promise<T> {
  const json = await rpcPayload(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), custom, method);
  const error = getRpcError(json);
  if (error) throw new Error(`${custom ? "Custom RPC" : "Solana RPC"}: ${error}`);
  if (!json || typeof json !== "object" || !("result" in json)) throw new Error("RPC returned an invalid JSON-RPC response.");
  return json.result as T;
}

async function rpcBatch<T>(calls: { id: string; method: string; params: unknown[] }[], custom: CustomRpcTarget): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  for (let index = 0; index < calls.length; index += 10) {
    // Helius Free is limited to 10 RPC calls/s. Space 10-item historical batches
    // so a 500-signature scan does not burst all its calls at once.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const batch = calls.slice(index, index + 10);
    const json = await rpcPayload(JSON.stringify(batch.map((call) => ({ jsonrpc: "2.0", ...call }))), custom, "getTransaction batch");
    if (!Array.isArray(json)) throw new Error("This RPC does not support batched transaction requests. Lower the transaction limit or use another RPC.");
    for (const item of json) {
      const error = getRpcError(item);
      if (error) throw new Error(`Custom RPC getTransaction batch: ${error}`);
      if (item && typeof item === "object" && "id" in item && "result" in item) results.set(String(item.id), item.result as T);
    }
  }
  return results;
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
    const heliusRpc = custom?.url.hostname.endsWith("helius-rpc.com") ?? false;
    const batchSize = heliusRpc ? 500 : 3;
    for (let index = 0; index < successful.length; index += batchSize) {
      const batch = successful.slice(index, index + batchSize);
      const transactions = heliusRpc && custom
        ? await rpcBatch<Parameters<typeof transfersFromTransaction>[0]>(batch.map((item) => ({
          id: item.signature,
          method: "getTransaction",
          params: [item.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
        })), custom).then((bySignature) => batch.map((item) => ({
          signature: item.signature,
          tx: bySignature.get(item.signature) ?? null,
        })))
        : await Promise.all(batch.map(async (item) => ({
          signature: item.signature,
          tx: await rpc<Parameters<typeof transfersFromTransaction>[0]>("getTransaction", [item.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }], custom),
        })));
      for (const item of transactions) {
        const parsed = transfersFromTransaction(item.tx, item.signature, address);
        const transaction = excludeTrades && parsed.tradeLike ? { transfers: [], tradeLike: true } : parsed;
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
