# Wallet Atlas

Wallet Atlas traces **observed SOL and SPL token transfers** from a Solana address and draws a graph of connected addresses. Paste a second address to highlight every shortest observed route between the two wallets. The comparison result lists every transfer event on those routes with its amount and a Solscan transaction link. “Parent” means an address sent assets to the selected address; “child” means it received assets. These labels do not imply identity or shared ownership.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The default data source is Solana's public mainnet RPC. For more reliable use, set `SOLANA_RPC_URL` to your own mainnet RPC endpoint in `.env.local` and in Vercel project settings. Never commit that value.

You can also select **Custom RPC** on the website and paste an HTTPS mainnet RPC URL. It applies to scans from that browser tab, including wallet comparison. The URL is sent to the app server for RPC requests and is not saved in a database or browser storage. The server checks the mainnet genesis hash, rejects private network addresses, and does not follow redirects.

## What a scan covers

- Scans a selectable 1–100 generations, at most 100 addresses and 100 visible nodes.
- Checks the newest 5, 10, 25, 50, 100, 250, or 500 transaction signatures per scanned address.
- Reads parsed top-level and inner SOL/SPL token transfer instructions. Failed transactions, zero transfers, fees, swaps without a resolvable transfer owner, and non-transfer interactions are excluded.
- Trade filtering is optional. With it on, transactions with parsed swap instructions or different assets moving both into and out of the wallet are skipped; one-way token sends and receives remain in the graph. This is a transaction-pattern heuristic, so unusual swaps or complex payments can be classified imperfectly.
- The interface has rounded light and dark themes; your theme choice stays in this browser.
- Links token accounts to owner wallets when the transaction's token-balance metadata provides the owner. Token activity missing the owner from the searched wallet's signature history may be missed.
- Reports a path only within the transfers actually found. “No path found” does not prove two addresses have never interacted.
- Public RPC can rate limit requests or omit older transaction history. Use an archive RPC or indexed transfer API to investigate complete historical graphs.
- Large scans make many RPC requests and can take longer or hit provider limits. The app checks up to 100 addresses per trace; depth is a maximum hop count, not a guarantee that every branch has complete history.

The site does not request wallet signatures, connect wallets, store submitted addresses, or contain a demo dataset.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```
