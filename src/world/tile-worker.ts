/// <reference lib="webworker" />
import * as THREE from "three";
import type { OsmNode, OsmWay, OverpassResponse, RoadKind } from "../types";
import { makeProjector, type Projector } from "./project";
import {
  BUILDING_KINDS,
  type BuildingAABB,
  type BuildingKind,
  classifyBuilding as _classifyBuilding,
} from "./buildings-shared";
import { buildTreeInstances, type TreeInstance } from "./trees";
import { buildPeakInstances, type PeakInstance } from "./peaks";

// --- Geometry helpers (run on worker thread) ---

// Bounding sphere from positions (mirrors THREE.BufferGeometry.computeBoundingSphere).
type BSphere = { cx: number; cy: number; cz: number; radius: number };
function computeSphere(positions: Float32Array): BSphere {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return { cx, cy, cz, radius: Math.sqrt(r2) };
}

// Per-vertex normals from indexed triangles (mirrors THREE.BufferGeometry.computeVertexNormals).
function computeNormalsIndexed(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const l = Math.hypot(x, y, z) || 1;
    normals[i] = x / l;
    normals[i + 1] = y / l;
    normals[i + 2] = z / l;
  }
  return normals;
}

// --- Overpass classification (mirrors what fetchTile used to do on main thread) ---

type ClassifiedTile = {
  buildings: OsmWay[];
  roads: Record<RoadKind, OsmWay[]>;
  trees: OsmNode[];
  peaks: OsmNode[];
};

function classifyElements(data: OverpassResponse): ClassifiedTile {
  const buildings: OsmWay[] = [];
  const roads: Record<RoadKind, OsmWay[]> = {
    car: [], bike: [], bus: [], tram: [], footway: [], river: [],
  };
  const trees: OsmNode[] = [];
  const peaks: OsmNode[] = [];

  for (const el of data.elements) {
    if (el.type === "way" && el.geometry?.length) {
      const t = el.tags ?? {};
      if (t.building) {
        buildings.push(el);
      } else if (t.waterway) {
        roads.river.push(el);
      } else if (t.railway === "tram") {
        roads.tram.push(el);
      } else if (t.highway) {
        const h = t.highway;
        if (h === "cycleway") roads.bike.push(el);
        else if (h === "busway" || t.busway) roads.bus.push(el);
        else if (h === "footway" || h === "path" || h === "pedestrian" || h === "steps")
          roads.footway.push(el);
        else roads.car.push(el);
      }
    } else if (el.type === "node") {
      if (el.tags?.natural === "tree") trees.push(el);
      else if (el.tags?.natural === "peak") peaks.push(el);
    }
  }
  return { buildings, roads, trees, peaks };
}

// --- Building build (typed arrays) ---

const DEFAULT_HEIGHT = 8;
const WINDOW_W_M = 4;
const WINDOW_H_M = 12;

type Pt = { x: number; z: number };

function parseHeight(tags: Record<string, string> | undefined): number {
  if (!tags) return DEFAULT_HEIGHT;
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (Number.isFinite(h) && h > 0) return h;
  }
  if (tags["building:levels"]) {
    const l = parseFloat(tags["building:levels"]);
    if (Number.isFinite(l) && l > 0) return l * 3.2;
  }
  return DEFAULT_HEIGHT;
}

function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

type BuildingRaw = {
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  bsphere: BSphere;
  count: number;
  aabbs: BuildingAABB[];
};

type PreparedBuilding = {
  kind: BuildingKind;
  ring: Pt[];
  h: number;
  tris: number[][];
  aabb: BuildingAABB;
  bb: { minX: number; maxX: number; minZ: number; maxZ: number };
};

function pointInRing(px: number, pz: number, ring: Pt[]): boolean {
  let inside = false;
  const N = ring.length;
  for (let i = 0, j = N - 1; i < N; j = i++) {
    const xi = ring[i].x, zi = ring[i].z;
    const xj = ring[j].x, zj = ring[j].z;
    const intersect =
      zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function prepareBuilding(w: OsmWay, kind: BuildingKind, proj: Projector): PreparedBuilding | null {
  const pts = w.geometry;
  if (pts.length < 4) return null;
  const closed =
    pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon;
  const raw = closed ? pts.slice(0, -1) : pts;
  if (raw.length < 3) return null;

  let ring: Pt[] = raw.map((p) => proj.toLocal(p.lat, p.lon));
  const area = signedArea(ring);
  if (Math.abs(area) < 1) return null;
  if (area < 0) ring = ring.slice().reverse();

  const h = parseHeight(w.tags);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  const verts2d = ring.map((p) => new THREE.Vector2(p.x, p.z));
  const tris = THREE.ShapeUtils.triangulateShape(verts2d, []);
  if (!tris.length) return null;

  return {
    kind,
    ring,
    h,
    tris,
    bb: { minX, maxX, minZ, maxZ },
    aabb: {
      cx: (minX + maxX) / 2,
      cy: h / 2,
      cz: (minZ + maxZ) / 2,
      hx: (maxX - minX) / 2,
      hy: h / 2,
      hz: (maxZ - minZ) / 2,
    },
  };
}

// 1cm quantization → exact-shared edges hash to same key regardless of
// vertex order.
function edgeKey(ax: number, az: number, bx: number, bz: number): string {
  const q = 100;
  const a0 = Math.round(ax * q), a1 = Math.round(az * q);
  const b0 = Math.round(bx * q), b1 = Math.round(bz * q);
  if (a0 < b0 || (a0 === b0 && a1 < b1)) return `${a0},${a1}|${b0},${b1}`;
  return `${b0},${b1}|${a0},${a1}`;
}

type Occlusion = {
  // Per-building list of neighbor indices whose AABB overlaps and whose height
  // matters for occlusion. Empty list → all walls exterior, skip per-edge test.
  neighbors: number[][];
  // Edges shared with another building (exact endpoints). Both sides hidden.
  sharedEdges: Set<string>;
};

function computeOcclusion(prepared: PreparedBuilding[]): Occlusion {
  const N = prepared.length;
  const neighbors: number[][] = Array.from({ length: N }, () => []);
  const edgeCount = new Map<string, number>();

  for (let i = 0; i < N; i++) {
    const a = prepared[i];
    const ar = a.ring;
    for (let k = 0; k < ar.length; k++) {
      const p = ar[k];
      const q = ar[(k + 1) % ar.length];
      const key = edgeKey(p.x, p.z, q.x, q.z);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
    for (let j = i + 1; j < N; j++) {
      const b = prepared[j];
      const ab = a.bb, bb = b.bb;
      if (ab.maxX < bb.minX || ab.minX > bb.maxX) continue;
      if (ab.maxZ < bb.minZ || ab.minZ > bb.maxZ) continue;
      // Symmetric height filter — only register if either could occlude the other.
      if (b.h >= a.h * 0.5) neighbors[i].push(j);
      if (a.h >= b.h * 0.5) neighbors[j].push(i);
    }
  }

  const sharedEdges = new Set<string>();
  for (const [k, c] of edgeCount) if (c > 1) sharedEdges.add(k);
  return { neighbors, sharedEdges };
}

// Build per-kind raw geometry. Walls hidden by neighbor polygons skipped.
function buildBuildingsRawFromPrepared(
  prepared: PreparedBuilding[],
  occ: Occlusion,
  kind: BuildingKind,
): BuildingRaw | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const aabbs: BuildingAABB[] = [];
  let baseV = 0;
  let count = 0;

  for (let bi = 0; bi < prepared.length; bi++) {
    const b = prepared[bi];
    if (b.kind !== kind) continue;
    const { ring, h, tris, aabb } = b;
    const N = ring.length;
    aabbs.push(aabb);

    // Roof.
    for (let i = 0; i < N; i++) {
      positions.push(ring[i].x, h, ring[i].z);
      uvs.push(ring[i].x / WINDOW_W_M, ring[i].z / WINDOW_W_M);
    }
    for (const [a, b, c] of tris) {
      // CCW shape (x,z) → +y normal for roof when read as (a,b,c).
      indices.push(baseV + a, baseV + b, baseV + c);
    }
    baseV += N;

    const nbrs = occ.neighbors[bi];
    const noNeighbors = nbrs.length === 0;
    let perim = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const ax = ring[i].x, az = ring[i].z;
      const bx = ring[j].x, bz = ring[j].z;
      const len = Math.hypot(bx - ax, bz - az);
      const u0 = perim / WINDOW_W_M;
      const u1 = (perim + len) / WINDOW_W_M;
      const v1 = h / WINDOW_H_M;
      perim += len;

      let occluded = false;

      // Cheap hash: exact-shared edge with any neighbor → both sides hidden.
      if (!noNeighbors && occ.sharedEdges.has(edgeKey(ax, az, bx, bz))) {
        occluded = true;
      } else if (!noNeighbors) {
        // Sample slightly OUTWARD; if inside a neighbor polygon, this wall is
        // an internal partition.
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const dx = bx - ax, dz = bz - az;
        const nl = Math.hypot(dx, dz) || 1;
        const ox = dz / nl, oz = -dx / nl;
        const eps = 0.05;
        const tx = mx + ox * eps;
        const tz = mz + oz * eps;
        for (const k of nbrs) {
          const other = prepared[k];
          const obb = other.bb;
          if (tx < obb.minX || tx > obb.maxX || tz < obb.minZ || tz > obb.maxZ) continue;
          if (pointInRing(tx, tz, other.ring)) {
            occluded = true;
            break;
          }
        }
      }
      if (occluded) continue;

      positions.push(ax, 0, az); uvs.push(u0, 0);
      positions.push(bx, 0, bz); uvs.push(u1, 0);
      positions.push(bx, h, bz); uvs.push(u1, v1);
      positions.push(ax, h, az); uvs.push(u0, v1);
      // Outward winding: faces away from polygon interior (CCW ring).
      indices.push(baseV, baseV + 2, baseV + 1, baseV, baseV + 3, baseV + 2);
      baseV += 4;
    }
    count++;
  }

  if (!positions.length) return null;
  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  return {
    positions: pos,
    uvs: new Float32Array(uvs),
    normals: computeNormalsIndexed(pos, idx),
    indices: idx,
    bsphere: computeSphere(pos),
    count,
    aabbs,
  };
}

// --- Road build (typed arrays) ---

const HIGHWAY_WIDTHS: Record<string, number> = {
  motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
  residential: 5, unclassified: 5, service: 4, living_street: 4,
  pedestrian: 3, footway: 2, path: 2, cycleway: 2.5, track: 3,
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

type RoadRaw = {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  bsphere: BSphere;
};

function buildRoadsRaw(ways: OsmWay[], proj: Projector, kind: RoadKind): RoadRaw | null {
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
      // Faces +y (up).
      indices.push(vIndex, vIndex + 2, vIndex + 1);
      indices.push(vIndex + 1, vIndex + 2, vIndex + 3);
      vIndex += 4;
      traveled += len;
    }
  }

  if (!positions.length) return null;
  const pos = new Float32Array(positions);
  return {
    positions: pos,
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    bsphere: computeSphere(pos),
  };
}

// --- Worker entry ---

const ROAD_KINDS: RoadKind[] = ["river", "tram", "footway", "bike", "bus", "car"];

export type WorkerInput = {
  reqId: number;
  tx: number;
  tz: number;
  data: OverpassResponse;
  originLat: number;
  originLon: number;
};

export type WorkerOutput = {
  reqId: number;
  buildings: Partial<Record<BuildingKind, BuildingRaw>>;
  roads: Partial<Record<RoadKind, RoadRaw>>;
  trees: TreeInstance[];
  peaks: PeakInstance[];
};

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const { reqId, data, originLat, originLon } = e.data;
  const proj = makeProjector({ lat: originLat, lon: originLon });

  // Classify Overpass elements (was on main thread in fetchTile).
  const classified = classifyElements(data);

  // Prepare every building once so wall-occlusion can test across kinds.
  const prepared: PreparedBuilding[] = [];
  for (const w of classified.buildings) {
    const kind = _classifyBuilding(w.tags);
    const p = prepareBuilding(w, kind, proj);
    if (p) prepared.push(p);
  }
  const occ = computeOcclusion(prepared);
  const buildings: Partial<Record<BuildingKind, BuildingRaw>> = {};
  for (const k of BUILDING_KINDS) {
    const r = buildBuildingsRawFromPrepared(prepared, occ, k);
    if (r) buildings[k] = r;
  }

  const roads: Partial<Record<RoadKind, RoadRaw>> = {};
  for (const k of ROAD_KINDS) {
    const r = buildRoadsRaw(classified.roads[k], proj, k);
    if (r) roads[k] = r;
  }

  const trees = buildTreeInstances(classified.trees, proj);
  const peaks = buildPeakInstances(classified.peaks, proj);

  const out: WorkerOutput = { reqId, buildings, roads, trees, peaks };

  // Collect transferable buffers — zero-copy transfer to main thread.
  const transfers: Transferable[] = [];
  for (const k of Object.keys(buildings) as BuildingKind[]) {
    const r = buildings[k]!;
    transfers.push(
      r.positions.buffer as ArrayBuffer,
      r.uvs.buffer as ArrayBuffer,
      r.normals.buffer as ArrayBuffer,
      r.indices.buffer as ArrayBuffer,
    );
  }
  for (const k of Object.keys(roads) as RoadKind[]) {
    const r = roads[k]!;
    transfers.push(r.positions.buffer as ArrayBuffer, r.uvs.buffer as ArrayBuffer, r.indices.buffer as ArrayBuffer);
  }

  (self as unknown as Worker).postMessage(out, transfers);
};

export {};
