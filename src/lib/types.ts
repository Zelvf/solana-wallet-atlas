export type Transfer = {
  source: string;
  target: string;
  signature: string;
  asset: string;
  amount: string;
  decimals: number;
  blockTime: number | null;
};

export type ScanResponse = {
  address: string;
  transfers: Transfer[];
  signaturesChecked: number;
  hasMoreHistory: boolean;
  tradeTransactionsExcluded: number;
  rpc: "public" | "configured" | "custom";
};

export type WalletNode = { id: string; depth: number; origin: "root" | "comparison" };

export function shortAddress(address: string) {
  return `${address.slice(0, 5)}…${address.slice(-5)}`;
}

export function amountText(raw: string, decimals: number) {
  const value = Number(raw) / 10 ** decimals;
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value) : raw;
}
