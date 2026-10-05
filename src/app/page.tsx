"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { amountText, shortAddress, type ScanResponse, type Transfer, type WalletNode } from "@/lib/types";
import { relationship, shortestPath } from "@/lib/graph";

const GraphView = dynamic(() => import("@/components/graph-view"), { ssr: false, loading: () => <div className="graph-surface" /> });
const MAX_SCANNED = 24;
const MAX_NODES = 100;

export default function Home() {
  const [input, setInput] = useState("");
  const [root, setRoot] = useState("");
  const [compareInput, setCompareInput] = useState("");
  const [comparison, setComparison] = useState("");
  const [depth, setDepth] = useState(2);
  const [limit, setLimit] = useState(10);
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

  const path = useMemo(() => root && comparison ? shortestPath(root, comparison, transfers) : null, [root, comparison, transfers]);
  const selectedPath = useMemo(() => root && selected ? shortestPath(root, selected, transfers) : null, [root, selected, transfers]);
  const selectedTransfers = useMemo(() => transfers.filter((edge) => edge.source === selected || edge.target === selected).slice(0, 8), [transfers, selected]);
  const scannedNodeCount = scanned;

  async function scan(start: string, isComparison = false) {
    const address = start.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) { setError("Enter a valid Solana wallet address."); return; }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setError(""); setStoppedEarly(false);
    if (!isComparison) {
      setRoot(address); setComparison(""); setCompareInput(""); setNodes([{ id: address, depth: 0, origin: "root" }]);
      setTransfers([]); setSelected(address); setScanned(0); setSignatures(0); setSampled(0);
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
    let truncated = false;

    try {
      for (let index = 0; index < queue.length && processed < MAX_SCANNED; index++) {
        if (controller.signal.aborted) break;
        const item = queue[index];
        if (visited.has(item.address)) continue;
        visited.add(item.address);
        setStatus(`Scanning generation ${item.depth} · ${shortAddress(item.address)} · ${processed + 1}/${MAX_SCANNED} addresses`);
        const response = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: item.address, limit }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "The scan could not continue.");
        const result = data as ScanResponse;
        checked++; processed++; checkedSignatures += result.signaturesChecked;
        if (result.hasMoreHistory) sampledWallets++;
        setScanned(checked); setSignatures(checkedSignatures); setSampled(sampledWallets);
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
      else setStatus(`Scan complete for this bounded search · ${processed} addresses checked`);
    } catch (caught) {
      if (controller.signal.aborted) setStatus("Scan stopped. The graph shows only what was fetched.");
      else { setError(caught instanceof Error ? caught.message : "Scan failed."); setStatus("Scan interrupted. Results are partial."); setStoppedEarly(true); }
    } finally { setRunning(false); }
  }

  function stop() { abortRef.current?.abort(); }
  const currentPath = path || selectedPath;
  const canCompare = Boolean(root);

  return <main>
    <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">◉</span><span>WALLET<span className="brand-light">ATLAS</span></span></Link><div className="top-right"><span className="live-dot" /> MAINNET <span className="nav-separator">/</span> TRANSFER GRAPH</div></header>

    <div className="shell">
      <section className="intro"><div className="intro-main"><div className="kicker"><span className="kicker-line" /> ONCHAIN INTELLIGENCE <span className="kicker-index">01 / 03</span></div><h1>Every transfer<br /><em>tells a story.</em></h1><p>Trace SOL and token transfers across connected addresses. Follow the path, compare wallets, and see how many hops separate them.</p></div><div className="intro-aside"><span>NETWORK</span><strong>Solana<br />Mainnet</strong><div className="aside-orb">✦</div><small>Live RPC data<br />No wallet connection needed</small></div></section>

      <section className="search-panel"><div className="section-label"><span className="step-number">01</span><span>START A TRACE</span><span className="section-rule" /></div><form className="search-row" onSubmit={(event) => { event.preventDefault(); scan(input); }}><div className="address-field"><span className="field-icon">⌕</span><input aria-label="Solana wallet address" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Paste a Solana wallet address..." spellCheck={false} /><span className="field-tag">SOL</span></div><button className="primary-button" type="submit" disabled={running}>TRACE WALLET <span>↗</span></button></form><div className="search-options"><div className="option-group"><span>GENERATIONS</span>{[1, 2, 3].map((value) => <button className={depth === value ? "option active" : "option"} key={value} onClick={() => setDepth(value)} disabled={running}>{value} {value === 1 ? "hop" : "hops"}</button>)}</div><div className="option-group"><span>RECENT TX / ADDRESS</span><select aria-label="Recent transactions per address" value={limit} onChange={(event) => setLimit(Number(event.target.value))} disabled={running}><option value={5}>5 transactions</option><option value={10}>10 transactions</option><option value={25}>25 transactions</option></select></div><span className="limit-note">Up to {MAX_SCANNED} scanned · {MAX_NODES} shown</span></div></section>

      {(error || status) && <div className={`status-bar ${error ? "status-error" : ""}`}><span className={running ? "pulse-dot" : "status-dot"} />{error || status}{running && <button onClick={stop}>STOP SCAN</button>}</div>}

      <section className="metrics"><div><span>ADDRESSES FOUND</span><strong>{nodes.length.toString().padStart(2, "0")}</strong><small>in visible graph</small></div><div><span>TRANSFER EVENTS</span><strong>{transfers.length.toString().padStart(2, "0")}</strong><small>SOL + SPL</small></div><div><span>ADDRESSES SCANNED</span><strong>{scanned.toString().padStart(2, "0")}</strong><small>across both traces</small></div><div><span>TRANSACTIONS CHECKED</span><strong>{signatures.toString().padStart(2, "0")}</strong><small>most recent per address</small></div></section>

      <section className="workspace-grid"><div className="graph-card"><div className="card-heading"><div><div className="section-label"><span className="step-number">02</span><span>NETWORK MAP</span></div><h2>Connection graph</h2></div><span className="card-hint">DRAG TO EXPLORE · SCROLL TO ZOOM</span></div><GraphView nodes={nodes} transfers={transfers} root={root} comparison={comparison} selected={selected} path={currentPath} onSelect={setSelected} /><div className="graph-footer"><div><span className="legend-dot root-color" /> Root address</div><div><span className="legend-dot compare-color" /> Comparison</div><div><span className="legend-dot wallet-color" /> Connected address</div><span className="graph-count">{nodes.length} NODES / {transfers.length} EVENTS</span></div></div>

      <div className="side-stack"><div className="compare-card"><div className="section-label"><span className="step-number">03</span><span>COMPARE WALLETS</span></div><h2>Are they connected?</h2><p>Enter a second address to reveal the shortest observed transfer path.</p><form onSubmit={(event) => { event.preventDefault(); if (canCompare) { setComparison(compareInput.trim()); if (!nodes.some((node) => node.id === compareInput.trim())) scan(compareInput, true); } }}><input aria-label="Compare wallet address" value={compareInput} onChange={(event) => setCompareInput(event.target.value)} placeholder="Second wallet address" disabled={!canCompare || running} spellCheck={false} /><button disabled={!canCompare || running || !compareInput.trim()} type="submit">FIND CONNECTION <span>↗</span></button></form>{!canCompare && <div className="muted-note">Trace the first wallet to enable comparison.</div>}{comparison && <div className="comparison-result"><span className="result-label">RELATIONSHIP RESULT</span>{path ? <><strong className="connected">● CONNECTED</strong><div className="result-title">{relationship(path, transfers)}</div><div className="path-line">{path.map((address, index) => <span key={`${address}-${index}`}>{index > 0 && <b>→</b>}<button onClick={() => setSelected(address)}>{shortAddress(address)}</button></span>)}</div><small>{path.length - 1} {path.length === 2 ? "transfer hop" : "transfer hops"} in the observed graph. Arrows above show path order; transfer direction is shown in the label.</small></> : <><strong className="unconnected">○ NO PATH FOUND</strong><small>These addresses were not linked in the transactions scanned. This is not proof that no link exists.</small></>}</div>}</div>

      <div className="inspector-card"><div className="section-label"><span className="step-number">↳</span><span>ADDRESS INSPECTOR</span></div>{selected ? <><div className="inspector-address">{shortAddress(selected)} <button title="Copy address" onClick={() => navigator.clipboard.writeText(selected)}>⧉</button></div><div className="full-address">{selected}</div>{selectedPath && <div className="relation-tag">{relationship(selectedPath, transfers)}</div>}<div className="inspector-divider" /><div className="inspector-subtitle">OBSERVED TRANSFERS <span>{selectedTransfers.length}</span></div>{selectedTransfers.length ? <div className="transaction-list">{selectedTransfers.map((edge, index) => <a key={`${edge.signature}-${index}`} href={`https://solscan.io/tx/${edge.signature}`} target="_blank" rel="noreferrer"><span className={edge.source === selected ? "tx-arrow outgoing" : "tx-arrow incoming"}>{edge.source === selected ? "↗" : "↙"}</span><span className="tx-main"><strong>{edge.source === selected ? "Sent to" : "Received from"} {shortAddress(edge.source === selected ? edge.target : edge.source)}</strong><small>{edge.asset === "SOL" ? "SOL" : `TOKEN ${shortAddress(edge.asset)}`} · {edge.blockTime ? new Date(edge.blockTime * 1000).toLocaleDateString() : "confirmed"}</small></span><span className="tx-amount">{amountText(edge.amount, edge.decimals)}</span></a>)}</div> : <div className="muted-note">No qualifying transfers in the scanned sample.</div>}</> : <div className="muted-note">Select a node to inspect its links and transactions.</div>}</div></div></section>

      <section className="wallet-list"><div className="list-title"><div><span className="eyebrow">DISCOVERED ADDRESSES</span><h2>Network directory</h2></div><span>{nodes.length} addresses</span></div>{nodes.length ? <div className="wallet-rows">{nodes.map((node, index) => { const nodePath = root ? shortestPath(root, node.id, transfers) : null; return <button key={node.id} className="wallet-row" onClick={() => setSelected(node.id)}><span className="row-index">{String(index + 1).padStart(2, "0")}</span><span className="row-address">{shortAddress(node.id)}<small>{node.id}</small></span><span className="row-relation">{node.id === root ? "ROOT" : nodePath ? relationship(nodePath, transfers) : "OTHER COMPONENT"}</span><span className="row-chevron">↗</span></button>; })}</div> : <div className="list-empty">No addresses yet. Start a trace above.</div>}</section>

      <footer><div className="footer-brand">◉ WALLETATLAS</div><p>Transfer links show movement of assets between addresses, not common ownership or identity. Labels such as parent and child describe transfer direction only.</p><p>Each trace samples the most recent {limit} transactions per scanned address, up to {MAX_SCANNED} addresses. {sampled > 0 && `${sampled} addresses may have older history outside the sample. `}{stoppedEarly && "The scan stopped before exploring every discovered address. "}Token transfers can be missed when the wallet owner is absent from a transaction’s address list. An archive RPC or indexer is needed for exhaustive history.</p></footer>
    </div>
  </main>;
}
