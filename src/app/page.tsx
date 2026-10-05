"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { amountText, shortAddress, type ScanResponse, type Transfer, type WalletNode } from "@/lib/types";
import { connectionKey, relationship, shortestPath, shortestPathNetwork } from "@/lib/graph";

const GraphView = dynamic(() => import("@/components/graph-view"), { ssr: false, loading: () => <div className="graph-surface" /> });
const MAX_SCANNED = 100;
const MAX_NODES = 100;

export default function Home() {
  const [input, setInput] = useState("");
  const [root, setRoot] = useState("");
  const [compareInput, setCompareInput] = useState("");
  const [comparison, setComparison] = useState("");
  const [depth, setDepth] = useState(2);
  const [limit, setLimit] = useState(10);
  const [excludeTrades, setExcludeTrades] = useState(true);
  const [tradesSkipped, setTradesSkipped] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [rpcMode, setRpcMode] = useState<"default" | "custom">("default");
  const [rpcInput, setRpcInput] = useState("");
  const [showRpc, setShowRpc] = useState(false);
  const [nodes, setNodes] = useState<WalletNode[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [selected, setSelected] = useState("");
  const [scanned, setScanned] = useState(0);
  const [signatures, setSignatures] = useState(0);
  const [sampled, setSampled] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [stoppedEarly, setStoppedEarly] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem("wallet-atlas-theme"); } catch { /* Theme storage can be disabled by the browser. */ }
    const initial = stored === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = initial;
    const frame = requestAnimationFrame(() => setTheme(initial));
    return () => cancelAnimationFrame(frame);
  }, []);

  function changeTheme(next: "dark" | "light") {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("wallet-atlas-theme", next); } catch { /* The theme still changes for this page session. */ }
  }

  const pathNetwork = useMemo(() => root && comparison ? shortestPathNetwork(root, comparison, transfers) : null, [root, comparison, transfers]);
  const path = pathNetwork?.path || null;
  const selectedNetwork = useMemo(() => root && selected ? shortestPathNetwork(root, selected, transfers) : null, [root, selected, transfers]);
  const selectedPath = selectedNetwork?.path || null;
  const selectedTransfers = useMemo(() => transfers.filter((edge) => edge.source === selected || edge.target === selected).slice(0, 8), [transfers, selected]);
  const pathTransfers = useMemo(() => {
    if (!pathNetwork) return [];
    const keys = new Set(pathNetwork.edgeKeys);
    return transfers.filter((edge) => keys.has(connectionKey(edge.source, edge.target)));
  }, [pathNetwork, transfers]);
  const scannedNodeCount = scanned;

  async function scan(start: string, isComparison = false) {
    const address = start.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) { setError("Enter a valid Solana wallet address."); return; }
    const rpcUrl = rpcMode === "custom" ? rpcInput.trim() : undefined;
    if (rpcMode === "custom") {
      try {
        if (new URL(rpcUrl || "").protocol !== "https:") throw new Error();
      } catch { setError("Enter a valid HTTPS custom RPC URL."); return; }
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setError(""); setStoppedEarly(false);
    if (!isComparison) {
      setRoot(address); setComparison(""); setCompareInput(""); setNodes([{ id: address, depth: 0, origin: "root" }]);
      setTransfers([]); setSelected(address); setScanned(0); setSignatures(0); setSampled(0); setTradesSkipped(0);
    } else {
      setComparison(address);
      setNodes((current) => current.some((node) => node.id === address) ? current : [...current, { id: address, depth: 0, origin: "comparison" }]);
    }

    const known = new Map<string, WalletNode>(isComparison ? nodes.map((node) => [node.id, node]) : []);
    if (!known.has(address)) known.set(address, { id: address, depth: 0, origin: isComparison ? "comparison" : "root" });
    const edges = isComparison ? [...transfers] : [];
    const seenEdges = new Set(edges.map((edge) => `${edge.signature}:${edge.source}:${edge.target}:${edge.asset}:${edge.amount}`));
    const queue: { address: string; depth: number }[] = [{ address, depth: 0 }];
    const visited = new Set<string>();
    let checked = isComparison ? scannedNodeCount : 0;
    let processed = 0;
    let checkedSignatures = isComparison ? signatures : 0;
    let sampledWallets = isComparison ? sampled : 0;
    let excludedTrades = isComparison ? tradesSkipped : 0;
    let truncated = false;

    try {
      for (let index = 0; index < queue.length && processed < MAX_SCANNED; index++) {
        if (controller.signal.aborted) break;
        const item = queue[index];
        if (visited.has(item.address)) continue;
        visited.add(item.address);
        setStatus(`Scanning generation ${item.depth} · ${shortAddress(item.address)} · ${processed + 1}/${MAX_SCANNED} addresses`);
        const response = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: item.address, limit, excludeTrades, ...(rpcUrl ? { rpcUrl } : {}) }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "The scan could not continue.");
        const result = data as ScanResponse;
        checked++; processed++; checkedSignatures += result.signaturesChecked;
        if (result.hasMoreHistory) sampledWallets++;
        excludedTrades += result.tradeTransactionsExcluded;
        setScanned(checked); setSignatures(checkedSignatures); setSampled(sampledWallets); setTradesSkipped(excludedTrades);
        for (const edge of result.transfers) {
          const key = `${edge.signature}:${edge.source}:${edge.target}:${edge.asset}:${edge.amount}`;
          const other = edge.source === item.address ? edge.target : edge.source;
          if (!known.has(other) && known.size >= MAX_NODES) { truncated = true; continue; }
          if (!seenEdges.has(key)) { seenEdges.add(key); edges.push(edge); }
          if (!known.has(other)) {
            known.set(other, { id: other, depth: item.depth + 1, origin: isComparison ? "comparison" : "root" });
            if (item.depth < depth - 1) queue.push({ address: other, depth: item.depth + 1 });
          } else if (item.depth < depth - 1 && !visited.has(other) && !queue.some((entry) => entry.address === other)) {
            queue.push({ address: other, depth: item.depth + 1 });
          }
        }
        setNodes([...known.values()]); setTransfers([...edges]);
      }
      if (controller.signal.aborted) setStatus("Scan stopped. The graph shows only what was fetched.");
      else if (processed >= MAX_SCANNED || truncated) { setStoppedEarly(true); setStatus("Scan reached its address budget. Results are partial."); }
      else setStatus(`Scan complete · ${processed} addresses checked · ${excludedTrades} trade-like transactions skipped · ${rpcUrl ? "custom RPC" : "default RPC"}`);
    } catch (caught) {
      if (controller.signal.aborted) setStatus("Scan stopped. The graph shows only what was fetched.");
      else { setError(caught instanceof Error ? caught.message : "Scan failed."); setStatus("Scan interrupted. Results are partial."); setStoppedEarly(true); }
    } finally { setRunning(false); }
  }

  function stop() { abortRef.current?.abort(); }
  const currentPath = pathNetwork?.nodes || selectedNetwork?.nodes || null;
  const currentPathEdges = pathNetwork?.edgeKeys || selectedNetwork?.edgeKeys || [];
  const canCompare = Boolean(root);

  return <main>
    <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">◉</span><span>WALLET<span className="brand-light">ATLAS</span></span></Link><div className="topbar-actions"><div className="top-right"><span className="live-dot" /> MAINNET <span className="nav-separator">/</span> TRANSFER GRAPH</div><button className="theme-toggle" type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => changeTheme(theme === "dark" ? "light" : "dark")}><span>{theme === "dark" ? "☼" : "◐"}</span><small>{theme === "dark" ? "LIGHT" : "DARK"}</small></button></div></header>

    <div className="shell">
      <section className="intro"><div className="intro-main"><div className="kicker"><span className="kicker-line" /> ONCHAIN INTELLIGENCE <span className="kicker-index">01 / 03</span></div><h1>Every transfer<br /><em>tells a story.</em></h1><p>Trace SOL and token transfers across connected addresses. Follow the path, compare wallets, and see how many hops separate them.</p></div><div className="intro-aside"><span>NETWORK</span><strong>Solana<br />Mainnet</strong><div className="aside-orb">✦</div><small>Live RPC data<br />No wallet connection needed</small></div></section>

      <section className="search-panel"><div className="section-label"><span className="step-number">01</span><span>START A TRACE</span><span className="section-rule" /></div><form className="search-row" onSubmit={(event) => { event.preventDefault(); scan(input); }}><div className="address-field"><span className="field-icon">⌕</span><input aria-label="Solana wallet address" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Paste a Solana wallet address..." spellCheck={false} /><span className="field-tag">SOL</span></div><button className="primary-button" type="submit" disabled={running}>TRACE WALLET <span>↗</span></button></form><div className="search-options"><div className="depth-control"><label htmlFor="scan-depth"><span>SCAN DEPTH</span><strong>{depth} <small>{depth === 1 ? "HOP" : "HOPS"}</small></strong></label><input id="scan-depth" aria-label="Scan depth in generations" type="range" min="1" max="100" value={depth} onChange={(event) => setDepth(Number(event.target.value))} disabled={running} /><div className="range-labels"><span>Direct</span><span>Extended network</span></div></div><div className="option-group"><span>RECENT TX / ADDRESS</span><select aria-label="Recent transactions per address" value={limit} onChange={(event) => setLimit(Number(event.target.value))} disabled={running}><option value={5}>5 transactions</option><option value={10}>10 transactions</option><option value={25}>25 transactions</option><option value={50}>50 transactions</option><option value={100}>100 transactions</option><option value={250}>250 transactions</option><option value={500}>500 transactions</option></select></div><span className="limit-note">Up to {MAX_SCANNED} scanned · {MAX_NODES} shown</span></div><div className="scan-filter-row"><label className="trade-toggle"><input type="checkbox" checked={excludeTrades} onChange={(event) => setExcludeTrades(event.target.checked)} disabled={running} /><span className="toggle-track"><i /></span><span><strong>Exclude token trades</strong><small>Skips likely buys and sells; keeps ordinary token transfers in and out.</small></span></label><span className="trade-count">{tradesSkipped} trade-like tx skipped</span></div><div className="rpc-settings"><div className="rpc-setting-top"><span>RPC SOURCE</span><div className="rpc-mode-switch"><button type="button" className={rpcMode === "default" ? "active" : ""} aria-pressed={rpcMode === "default"} disabled={running} onClick={() => setRpcMode("default")}>Default</button><button type="button" className={rpcMode === "custom" ? "active" : ""} aria-pressed={rpcMode === "custom"} disabled={running} onClick={() => setRpcMode("custom")}>Custom RPC</button></div></div>{rpcMode === "custom" && <div className="rpc-custom"><div className="rpc-input-wrap"><input aria-label="Custom RPC URL" type={showRpc ? "url" : "password"} value={rpcInput} onChange={(event) => setRpcInput(event.target.value)} placeholder="https://your-mainnet-rpc.example/your-key" autoComplete="off" spellCheck={false} disabled={running} /><button type="button" onClick={() => setShowRpc((value) => !value)} aria-label={showRpc ? "Hide RPC URL" : "Show RPC URL"}>{showRpc ? "HIDE" : "SHOW"}</button></div><p>HTTPS mainnet endpoints only. The URL is sent to this app&apos;s server for scans and is not saved.</p></div>}</div></section>

      {(error || status) && <div className={`status-bar ${error ? "status-error" : ""}`}><span className={running ? "pulse-dot" : "status-dot"} />{error || status}{running && <button onClick={stop}>STOP SCAN</button>}</div>}

      <section className="metrics"><div><span>ADDRESSES FOUND</span><strong>{nodes.length.toString().padStart(2, "0")}</strong><small>in visible graph</small></div><div><span>TRANSFER EVENTS</span><strong>{transfers.length.toString().padStart(2, "0")}</strong><small>SOL + SPL</small></div><div><span>ADDRESSES SCANNED</span><strong>{scanned.toString().padStart(2, "0")}</strong><small>across both traces</small></div><div><span>TRANSACTIONS CHECKED</span><strong>{signatures.toString().padStart(2, "0")}</strong><small>most recent per address</small></div></section>

      <section className="workspace-grid"><div className="graph-card"><div className="card-heading"><div><div className="section-label"><span className="step-number">02</span><span>NETWORK MAP</span></div><h2>Connection graph</h2></div><span className="card-hint">DRAG TO EXPLORE · SCROLL TO ZOOM</span></div><GraphView nodes={nodes} transfers={transfers} root={root} comparison={comparison} selected={selected} path={currentPath} pathEdges={currentPathEdges} theme={theme} onSelect={setSelected} /><div className="graph-footer"><div><span className="legend-dot root-color" /> Root address</div><div><span className="legend-dot compare-color" /> Comparison</div><div><span className="legend-dot wallet-color" /> Connected address</div><span className="graph-count">{nodes.length} NODES / {transfers.length} EVENTS</span></div></div>

      <div className="side-stack"><div className="compare-card"><div className="section-label"><span className="step-number">03</span><span>COMPARE WALLETS</span></div><h2>Are they connected?</h2><p>Enter a second address to reveal every shortest observed transfer route.</p><form onSubmit={(event) => { event.preventDefault(); if (canCompare) { setComparison(compareInput.trim()); if (!nodes.some((node) => node.id === compareInput.trim())) scan(compareInput, true); } }}><input aria-label="Compare wallet address" value={compareInput} onChange={(event) => setCompareInput(event.target.value)} placeholder="Second wallet address" disabled={!canCompare || running} spellCheck={false} /><button disabled={!canCompare || running || !compareInput.trim()} type="submit">FIND CONNECTION <span>↗</span></button></form>{!canCompare && <div className="muted-note">Trace the first wallet to enable comparison.</div>}{comparison && <div className="comparison-result"><span className="result-label">RELATIONSHIP RESULT</span>{path && pathNetwork ? <><strong className="connected">● CONNECTED</strong><div className="result-title">{relationship(path, transfers)}</div><div className="path-line">{path.map((address, index) => <span key={`${address}-${index}`}>{index > 0 && <b>→</b>}<button onClick={() => setSelected(address)}>{shortAddress(address)}</button></span>)}</div><small>{pathNetwork.distance} {pathNetwork.distance === 1 ? "transfer hop" : "transfer hops"}. {pathNetwork.routeCount.toLocaleString()} {pathNetwork.routeCount === 1 ? "shortest route is" : "shortest routes are"} highlighted on the graph.</small><div className="path-evidence"><div className="path-evidence-title"><span>PATH TRANSACTIONS</span><strong>{pathTransfers.length}</strong></div>{pathTransfers.map((edge, index) => <a key={`${edge.signature}-${edge.source}-${edge.target}-${index}`} href={`https://solscan.io/tx/${edge.signature}`} target="_blank" rel="noreferrer"><span className="path-evidence-route">{shortAddress(edge.source)} <b>→</b> {shortAddress(edge.target)}</span><span className="path-evidence-meta">{edge.asset === "SOL" ? "SOL" : `TOKEN ${shortAddress(edge.asset)}`} · {edge.blockTime ? new Date(edge.blockTime * 1000).toLocaleDateString() : "confirmed"}</span><strong>{amountText(edge.amount, edge.decimals)} <i>↗</i></strong></a>)}</div></> : <><strong className="unconnected">○ NO PATH FOUND</strong><small>These addresses were not linked in the transactions scanned. This is not proof that no link exists.</small></>}</div>}</div>

      <div className="inspector-card"><div className="section-label"><span className="step-number">↳</span><span>ADDRESS INSPECTOR</span></div>{selected ? <><div className="inspector-address">{shortAddress(selected)} <button title="Copy address" onClick={() => navigator.clipboard.writeText(selected)}>⧉</button></div><div className="full-address">{selected}</div>{selectedPath && <div className="relation-tag">{relationship(selectedPath, transfers)}</div>}<div className="inspector-divider" /><div className="inspector-subtitle">OBSERVED TRANSFERS <span>{selectedTransfers.length}</span></div>{selectedTransfers.length ? <div className="transaction-list">{selectedTransfers.map((edge, index) => <a key={`${edge.signature}-${index}`} href={`https://solscan.io/tx/${edge.signature}`} target="_blank" rel="noreferrer"><span className={edge.source === selected ? "tx-arrow outgoing" : "tx-arrow incoming"}>{edge.source === selected ? "↗" : "↙"}</span><span className="tx-main"><strong>{edge.source === selected ? "Sent to" : "Received from"} {shortAddress(edge.source === selected ? edge.target : edge.source)}</strong><small>{edge.asset === "SOL" ? "SOL" : `TOKEN ${shortAddress(edge.asset)}`} · {edge.blockTime ? new Date(edge.blockTime * 1000).toLocaleDateString() : "confirmed"}</small></span><span className="tx-amount">{amountText(edge.amount, edge.decimals)}</span></a>)}</div> : <div className="muted-note">No qualifying transfers in the scanned sample.</div>}</> : <div className="muted-note">Select a node to inspect its links and transactions.</div>}</div></div></section>

      <section className="wallet-list"><div className="list-title"><div><span className="eyebrow">DISCOVERED ADDRESSES</span><h2>Network directory</h2></div><span>{nodes.length} addresses</span></div>{nodes.length ? <div className="wallet-rows">{nodes.map((node, index) => { const nodePath = root ? shortestPath(root, node.id, transfers) : null; return <button key={node.id} className="wallet-row" onClick={() => setSelected(node.id)}><span className="row-index">{String(index + 1).padStart(2, "0")}</span><span className="row-address">{shortAddress(node.id)}<small>{node.id}</small></span><span className="row-relation">{node.id === root ? "ROOT" : nodePath ? relationship(nodePath, transfers) : "OTHER COMPONENT"}</span><span className="row-chevron">↗</span></button>; })}</div> : <div className="list-empty">No addresses yet. Start a trace above.</div>}</section>

      <footer><div className="footer-brand">◉ WALLETATLAS</div><p>Transfer links show movement of assets between addresses, not common ownership or identity. Labels such as parent and child describe transfer direction only.</p><p>Each trace samples the most recent {limit} transactions per scanned address, up to {MAX_SCANNED} addresses. {sampled > 0 && `${sampled} addresses may have older history outside the sample. `}{stoppedEarly && "The scan stopped before exploring every discovered address. "}Token transfers can be missed when the wallet owner is absent from a transaction’s address list. An archive RPC or indexer is needed for exhaustive history.</p></footer>
    </div>
  </main>;
}
