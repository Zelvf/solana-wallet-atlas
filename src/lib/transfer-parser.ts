import type { Transfer } from "./types";

type ParsedInstruction = { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } };
type TokenBalance = {
  accountIndex: number;
  owner?: string;
  mint?: string;
  uiTokenAmount?: { decimals?: number };
};
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

export function transfersFromTransaction(
  tx: ParsedTransaction | null,
  signature: string,
  address: string,
): { transfers: Transfer[]; tradeLike: boolean } {
  if (!tx?.meta || tx.meta.err) return { transfers: [], tradeLike: false };
  const keys = tx.transaction.message.accountKeys.map((item) => item.pubkey);
  const tokenAccounts = new Map<string, { owner?: string; mint?: string; decimals?: number }>();
  for (const balance of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    const account = keys[balance.accountIndex];
    if (account) tokenAccounts.set(account, {
      owner: balance.owner,
      mint: balance.mint,
      decimals: balance.uiTokenAmount?.decimals,
    });
  }
  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions || []).flatMap((item) => item.instructions),
  ];
  const allTransfers: Transfer[] = [];
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
      const fromAccount = tokenAccounts.get(String(info.source));
      const toAccount = tokenAccounts.get(String(info.destination));
      source = fromAccount?.owner;
      target = toAccount?.owner;
      amount = String((info.tokenAmount as { amount?: string } | undefined)?.amount ?? info.amount ?? "");
      decimals = Number((info.tokenAmount as { decimals?: number } | undefined)?.decimals ?? fromAccount?.decimals ?? 0);
      asset = String(info.mint || fromAccount?.mint || toAccount?.mint || "SPL token");
    }
    if (!source || !target || source === target || !amount || !/^\d+$/.test(amount) || !/[1-9]/.test(amount)) continue;
    if (source === address || target === address) {
      allTransfers.push({ source, target, signature, asset, amount, decimals, blockTime: tx.blockTime });
    }
  }

  const outgoing = new Set(allTransfers.filter((edge) => edge.source === address).map((edge) => edge.asset));
  const incoming = new Set(allTransfers.filter((edge) => edge.target === address).map((edge) => edge.asset));
  const crossAssetExchange = [...outgoing].some((asset) => [...incoming].some((received) => received !== asset));
  const parsedSwapInstruction = instructions.some((instruction) => /swap|exchange/i.test(instruction.parsed?.type || ""));
  return { transfers: allTransfers, tradeLike: crossAssetExchange || parsedSwapInstruction };
}
