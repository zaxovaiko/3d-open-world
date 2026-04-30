import * as THREE from "three";
import type { OsmWay, RoadKind } from "../types";
import type { Projector } from "./project";

const HIGHWAY_WIDTHS: Record<string, number> = {
  motorway: 10,
  trunk: 9,
  primary: 8,
  secondary: 7,
  tertiary: 6,
  residential: 5,
  unclassified: 5,
  service: 4,
  living_street: 4,
  pedestrian: 3,
  footway: 2,
  path: 2,
  cycleway: 2.5,
  track: 3,
};

const KIND_DEFAULTS: Record<RoadKind, { width: number; y: number; lengthScale: number }> = {
  car: { width: 5, y: 0.15, lengthScale: 8 },
  bike: { width: 2.2, y: 0.18, lengthScale: 4 },
  bus: { width: 6, y: 0.16, lengthScale: 8 },
  tram: { width: 3, y: 0.05, lengthScale: 2 },
  footway: { width: 2, y: 0.12, lengthScale: 3 },
  river: { width: 8, y: 0.04, lengthScale: 16 },
};

function widthFor(kind: RoadKind, w: OsmWay): number {
  const tags = w.tags;
  if (tags?.width) {
    const v = parseFloat(tags.width);
    if (Number.isFinite(v) && v > 0) return v;
  }
  if (kind === "car" && tags?.highway) {
    return HIGHWAY_WIDTHS[tags.highway] ?? KIND_DEFAULTS.car.width;
  }
  return KIND_DEFAULTS[kind].width;
}

export function buildRoadsGeometryByKind(
  ways: OsmWay[],
  proj: Projector,
  kind: RoadKind,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vIndex = 0;
  const cfg = KIND_DEFAULTS[kind];

  for (const w of ways) {
    const pts = w.geometry;
    if (pts.length < 2) continue;
    const halfW = widthFor(kind, w) / 2;

    const local = pts.map((p) => proj.toLocal(p.lat, p.lon));
    let traveled = 0;

    for (let i = 0; i < local.length - 1; i++) {
      const a = local[i];
      const b = local[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const ox = nx * halfW;
      const oz = nz * halfW;
      const v0 = traveled / cfg.lengthScale;
      const v1 = (traveled + len) / cfg.lengthScale;
      positions.push(a.x + ox, cfg.y, a.z + oz); uvs.push(0, v0);
      positions.push(a.x - ox, cfg.y, a.z - oz); uvs.push(1, v0);
      positions.push(b.x + ox, cfg.y, b.z + oz); uvs.push(0, v1);
      positions.push(b.x - ox, cfg.y, b.z - oz); uvs.push(1, v1);
      indices.push(vIndex, vIndex + 1, vIndex + 2);
      indices.push(vIndex + 1, vIndex + 3, vIndex + 2);
      vIndex += 4;
      traveled += len;
    }
  }

  if (!positions.length) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geom.setIndex(indices);
  return geom;
}
