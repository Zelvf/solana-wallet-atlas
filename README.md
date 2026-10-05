# Wallet Atlas

Wallet Atlas traces **observed SOL and SPL token transfers** from a Solana address and draws a graph of connected addresses. Paste a second address to find the shortest transfer path in the graph. “Parent” means an address sent assets to the selected address; “child” means it received assets. These labels do not imply identity or shared ownership.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The default data source is Solana's public mainnet RPC. For more reliable use, set `SOLANA_RPC_URL` to your own mainnet RPC endpoint in `.env.local` and in Vercel project settings. Never commit that value.

## What a scan covers

- Scans 1–3 generations, at most 24 addresses and 100 visible nodes.
- Checks the newest 5, 10, or 25 transaction signatures per scanned address.
- Reads parsed top-level and inner SOL/SPL token transfer instructions. Failed transactions, zero transfers, fees, swaps without a resolvable transfer owner, and non-transfer interactions are excluded.
- Links token accounts to owner wallets when the transaction's token-balance metadata provides the owner. Token activity missing the owner from the searched wallet's signature history may be missed.
- Reports a path only within the transfers actually found. “No path found” does not prove two addresses have never interacted.
- Public RPC can rate limit requests or omit older transaction history. Use an archive RPC or indexed transfer API to investigate complete historical graphs.

The site does not request wallet signatures, connect wallets, store submitted addresses, or contain a demo dataset.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```
