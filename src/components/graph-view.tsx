"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { Transfer, WalletNode } from "@/lib/types";
import { shortAddress } from "@/lib/types";
import { connectionKey } from "@/lib/graph";

type Props = {
  nodes: WalletNode[];
  transfers: Transfer[];
  root: string;
  comparison: string;
  selected: string;
  path: string[] | null;
  pathEdges: string[];
  theme: "dark" | "light";
  onSelect: (address: string) => void;
};

export default function GraphView({ nodes, transfers, root, comparison, selected, path, pathEdges, theme, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 780, height: 530 });

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  const highlighted = useMemo(() => new Set(path || []), [path]);
  const highlightedEdges = useMemo(() => new Set(pathEdges), [pathEdges]);
  const data = useMemo(() => {
    const unique = new Map<string, { source: string; target: string; count: number; active: boolean }>();
    for (const transfer of transfers) {
      const key = connectionKey(transfer.source, transfer.target);
      const current = unique.get(key);
      const active = highlightedEdges.has(key);
      if (current) { current.count++; current.active ||= active; }
      else unique.set(key, { source: transfer.source, target: transfer.target, count: 1, active });
    }
    return { nodes: nodes.map((node) => ({ ...node })), links: [...unique.values()] };
  }, [nodes, transfers, highlightedEdges]);

  useEffect(() => {
    if (!graph.current || !nodes.length) return;
    const timer = window.setTimeout(() => {
      if (nodes.length < 6) { graph.current?.centerAt(0, 0, 450); graph.current?.zoom(1.6, 450); }
      else graph.current?.zoomToFit(450, 85);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [nodes.length]);

  const color = (id: string) => id === root ? "#a8ff69" : id === comparison ? "#ffbf78" : highlighted.has(id) ? "#e9f89b" : "#8d9bba";

  return <div className="graph-surface" ref={container}>
    {nodes.length === 0 ? <div className="graph-empty">
      <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
      <div className="orbit-core">◎</div>
      <div className="empty-copy"><span className="eyebrow">READY TO EXPLORE</span><strong>Your network starts here.</strong><p>Paste a Solana address to reveal observed transfer connections.</p></div>
    </div> : <ForceGraph2D
      ref={graph}
      width={size.width}
      height={size.height}
      graphData={data}
      backgroundColor={theme === "light" ? "#f0f4ed" : "#111521"}
      cooldownTicks={100}
      linkColor={(link) => (link as { active: boolean }).active ? "#c9f791" : "rgba(132,150,185,.23)"}
      linkWidth={(link) => (link as { active: boolean }).active ? 2.7 : 1 + Math.log2((link as { count: number }).count + 1) * .35}
      linkDirectionalParticles={(link) => (link as { active: boolean }).active ? 2 : 0}
      linkDirectionalParticleColor={() => "#d9ff9d"}
      linkDirectionalParticleWidth={2.4}
      nodeRelSize={6}
      nodeVal={(node) => node.id === root ? 3 : node.id === comparison ? 2.4 : 1}
      onNodeClick={(node) => onSelect(node.id as string)}
      nodeCanvasObject={(node, ctx, globalScale) => {
        const id = node.id as string;
        const radius = (id === root ? 10 : id === comparison ? 8 : highlighted.has(id) ? 7 : 5) / globalScale;
        const x = node.x || 0; const y = node.y || 0;
        ctx.beginPath(); ctx.arc(x, y, radius + 5 / globalScale, 0, 2 * Math.PI); ctx.fillStyle = `${color(id)}18`; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.fillStyle = color(id); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, Math.max(1, radius - 2 / globalScale), 0, 2 * Math.PI); ctx.fillStyle = theme === "light" ? "#f0f4ed" : "#111521"; ctx.fill();
        if (globalScale > 1.15 || id === root || id === selected || id === comparison) {
          ctx.font = `${(id === root ? 12 : 10) / globalScale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.textAlign = "center"; ctx.fillStyle = id === root ? (theme === "light" ? "#314b25" : "#eaffd8") : (theme === "light" ? "#344052" : "#d8ddea");
          ctx.fillText(id === root ? "ROOT  " + shortAddress(id) : shortAddress(id), x, y + radius + 15 / globalScale);
        }
      }}
      nodePointerAreaPaint={(node, color, ctx, globalScale) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x || 0, node.y || 0, 13 / globalScale, 0, 2 * Math.PI); ctx.fill(); }}
    />}
    {nodes.length > 0 && <div className="graph-controls"><button title="Zoom in" onClick={() => graph.current?.zoom((graph.current.zoom() || 1) * 1.35, 300)}>+</button><button title="Zoom out" onClick={() => graph.current?.zoom((graph.current.zoom() || 1) / 1.35, 300)}>−</button><button title="Fit graph" onClick={() => graph.current?.zoomToFit(400, 65)}>⌖</button></div>}
  </div>;
}
