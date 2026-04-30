import type { OsmNode } from "../types";
import type { Projector } from "./project";

export type PeakInstance = { x: number; z: number; height: number; radius: number };

const DEFAULT_HEIGHT = 200;
const HEIGHT_TO_RADIUS = 1.6; // wider base than tall

export function buildPeakInstances(nodes: OsmNode[], proj: Projector): PeakInstance[] {
  return nodes.map((n) => {
    const ele = n.tags?.ele ? parseFloat(n.tags.ele) : NaN;
    // Treat OSM `ele` as absolute meters above sea; scale visually.
    // If unknown, use default. Cap to avoid absurd cones.
    const heightMeters = Number.isFinite(ele) ? Math.max(40, Math.min(800, ele * 0.25)) : DEFAULT_HEIGHT;
    const { x, z } = proj.toLocal(n.lat, n.lon);
    return { x, z, height: heightMeters, radius: heightMeters * HEIGHT_TO_RADIUS };
  });
}
