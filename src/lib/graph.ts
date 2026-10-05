import type { Transfer } from "./types";

export function neighborAddress(edge: Transfer, address: string) {
  if (edge.source === address) return edge.target;
  if (edge.target === address) return edge.source;
  return null;
}

export function shortestPath(start: string, end: string, edges: Transfer[]) {
  if (start === end) return [start];
  const seen = new Set([start]);
  const queue = [start];
  const previous = new Map<string, string>();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const edge of edges) {
      const next = neighborAddress(edge, current);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === end) {
        const path = [end];
        while (path[0] !== start) path.unshift(previous.get(path[0])!);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export function relationship(path: string[], edges: Transfer[]) {
  const hops = path.length - 1;
  if (hops === 0) return "Same address";
  let forward = 0;
  let backward = 0;
  for (let index = 0; index < hops; index++) {
    const a = path[index];
    const b = path[index + 1];
    if (edges.some((edge) => edge.source === a && edge.target === b)) forward++;
    if (edges.some((edge) => edge.source === b && edge.target === a)) backward++;
  }
  if (forward === hops && backward !== hops) return hops === 1 ? "Direct outgoing link · child" : `${hops} outgoing generations · descendant`;
  if (backward === hops && forward !== hops) return hops === 1 ? "Direct incoming link · parent" : `${hops} incoming generations · ancestor`;
  return hops === 1 ? "Direct two-way link" : `${hops} hops · mixed direction`;
}
