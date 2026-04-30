import type { OsmNode } from "../types";
import type { Projector } from "./project";

export type TreeKind = "broadleaf" | "conifer" | "palm" | "bush";

export type TreeInstance = {
  x: number;
  z: number;
  kind: TreeKind;
  scale: number;
};

const PALM_GENUS = new Set([
  "phoenix", "washingtonia", "trachycarpus", "cocos", "sabal", "syagrus",
]);

function classifyTree(n: OsmNode): TreeKind {
  const t = n.tags ?? {};
  const leaf = (t.leaf_type ?? "").toLowerCase();
  const genus = (t.genus ?? "").toLowerCase();
  const species = (t.species ?? "").toLowerCase();
  if (leaf === "needleleaved" || /pinus|picea|abies|spruce|pine|fir/.test(species))
    return "conifer";
  if (PALM_GENUS.has(genus) || /palm/.test(species)) return "palm";
  // Cheap deterministic spread by id so tiles look varied without randomness drift.
  if ((n.id & 7) === 0) return "bush";
  return "broadleaf";
}

function pseudoScale(id: number): number {
  // 0.85..1.25 deterministic per node.
  const r = Math.sin(id * 12.9898) * 43758.5453;
  const f = r - Math.floor(r);
  return 0.85 + f * 0.4;
}

export function buildTreeInstances(nodes: OsmNode[], proj: Projector): TreeInstance[] {
  return nodes.map((n) => {
    const { x, z } = proj.toLocal(n.lat, n.lon);
    return { x, z, kind: classifyTree(n), scale: pseudoScale(n.id) };
  });
}

export const TREE_KINDS: TreeKind[] = ["broadleaf", "conifer", "palm", "bush"];
