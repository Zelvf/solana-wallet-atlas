import type { Transfer } from "./types";

export function connectionKey(first: string, second: string) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

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

function distancesFrom(start: string, adjacency: Map<string, Set<string>>) {
  const distances = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const distance = distances.get(current)!;
    for (const next of adjacency.get(current) || []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

export function shortestPathNetwork(start: string, end: string, edges: Transfer[]) {
  const path = shortestPath(start, end, edges);
  if (!path) return null;

  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }

  const fromStart = distancesFrom(start, adjacency);
  const fromEnd = distancesFrom(end, adjacency);
  const distance = fromStart.get(end)!;
  const nodes = [...fromStart.keys()].filter((address) => fromStart.get(address)! + (fromEnd.get(address) ?? Infinity) === distance);
  const edgeKeys = new Set<string>();

  for (const edge of edges) {
    const sourceDistance = fromStart.get(edge.source);
    const targetDistance = fromStart.get(edge.target);
    const sourceToEnd = fromEnd.get(edge.source);
    const targetToEnd = fromEnd.get(edge.target);
    if ((sourceDistance !== undefined && targetToEnd !== undefined && sourceDistance + 1 + targetToEnd === distance) ||
        (targetDistance !== undefined && sourceToEnd !== undefined && targetDistance + 1 + sourceToEnd === distance)) {
      edgeKeys.add(connectionKey(edge.source, edge.target));
    }
  }

  const ways = new Map<string, number>([[start, 1]]);
  const ordered = [...nodes].sort((a, b) => fromStart.get(a)! - fromStart.get(b)!);
  for (const address of ordered) {
    const count = ways.get(address) || 0;
    for (const next of adjacency.get(address) || []) {
      if (fromStart.get(next) !== fromStart.get(address)! + 1 || fromStart.get(next)! + (fromEnd.get(next) ?? Infinity) !== distance) continue;
      ways.set(next, Math.min(Number.MAX_SAFE_INTEGER, (ways.get(next) || 0) + count));
    }
  }

  return { path, nodes, edgeKeys: [...edgeKeys], distance, routeCount: ways.get(end) || 1 };
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
