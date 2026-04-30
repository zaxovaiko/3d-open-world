/// <reference lib="webworker" />
import * as THREE from "three";
import type { OsmWay, RoadKind, TileData } from "../types";
import { makeProjector, type Projector } from "./project";
import {
  BUILDING_KINDS,
  type BuildingAABB,
  type BuildingKind,
  classifyBuilding as _classifyBuilding,
} from "./buildings-shared";
import { buildTreeInstances, type TreeInstance } from "./trees";
import { buildPeakInstances, type PeakInstance } from "./peaks";

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
  indices: Uint32Array;
  count: number;
  aabbs: BuildingAABB[];
};

function buildBuildingsRaw(ways: OsmWay[], proj: Projector): BuildingRaw | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const aabbs: BuildingAABB[] = [];
  let baseV = 0;
  let count = 0;

  for (const w of ways) {
    const pts = w.geometry;
    if (pts.length < 4) continue;
    const closed =
      pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon;
    const raw = closed ? pts.slice(0, -1) : pts;
    if (raw.length < 3) continue;

    let ring: Pt[] = raw.map((p) => proj.toLocal(p.lat, p.lon));
    const area = signedArea(ring);
    if (Math.abs(area) < 1) continue;
    if (area < 0) ring = ring.slice().reverse();

    const h = parseHeight(w.tags);
    const N = ring.length;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    aabbs.push({
      cx: (minX + maxX) / 2,
      cy: h / 2,
      cz: (minZ + maxZ) / 2,
      hx: (maxX - minX) / 2,
      hy: h / 2,
      hz: (maxZ - minZ) / 2,
    });

    const verts2d = ring.map((p) => new THREE.Vector2(p.x, p.z));
    const tris = THREE.ShapeUtils.triangulateShape(verts2d, []);
    if (!tris.length) continue;

    for (let i = 0; i < N; i++) {
      positions.push(ring[i].x, h, ring[i].z);
      uvs.push(ring[i].x / WINDOW_W_M, ring[i].z / WINDOW_W_M);
    }
    for (const [a, b, c] of tris) {
      indices.push(baseV + a, baseV + c, baseV + b);
    }
    baseV += N;

    let perim = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const ax = ring[i].x, az = ring[i].z;
      const bx = ring[j].x, bz = ring[j].z;
      const len = Math.hypot(bx - ax, bz - az);
      const u0 = perim / WINDOW_W_M;
      const u1 = (perim + len) / WINDOW_W_M;
      const v1 = h / WINDOW_H_M;
      positions.push(ax, 0, az); uvs.push(u0, 0);
      positions.push(bx, 0, bz); uvs.push(u1, 0);
      positions.push(bx, h, bz); uvs.push(u1, v1);
      positions.push(ax, h, az); uvs.push(u0, v1);
      indices.push(baseV, baseV + 1, baseV + 2, baseV, baseV + 2, baseV + 3);
      baseV += 4;
      perim += len;
    }
    count++;
  }

  if (!positions.length) return null;
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
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
      indices.push(vIndex, vIndex + 1, vIndex + 2);
      indices.push(vIndex + 1, vIndex + 3, vIndex + 2);
      vIndex += 4;
      traveled += len;
    }
  }

  if (!positions.length) return null;
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

// --- Worker entry ---

const ROAD_KINDS: RoadKind[] = ["river", "tram", "footway", "bike", "bus", "car"];

export type WorkerInput = {
  reqId: number;
  tile: TileData;
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
  const { reqId, tile, originLat, originLon } = e.data;
  const proj = makeProjector({ lat: originLat, lon: originLon });

  const buckets: Record<BuildingKind, OsmWay[]> = {
    residential: [],
    commercial: [],
    industrial: [],
    civic: [],
    generic: [],
  };
  for (const w of tile.buildings) buckets[_classifyBuilding(w.tags)].push(w);
  const buildings: Partial<Record<BuildingKind, BuildingRaw>> = {};
  for (const k of BUILDING_KINDS) {
    const r = buildBuildingsRaw(buckets[k], proj);
    if (r) buildings[k] = r;
  }

  const roads: Partial<Record<RoadKind, RoadRaw>> = {};
  for (const k of ROAD_KINDS) {
    const r = buildRoadsRaw(tile.roads[k], proj, k);
    if (r) roads[k] = r;
  }

  const trees = buildTreeInstances(tile.trees, proj);
  const peaks = buildPeakInstances(tile.peaks, proj);

  const out: WorkerOutput = { reqId, buildings, roads, trees, peaks };

  // Collect transferable buffers.
  const transfers: Transferable[] = [];
  for (const k of Object.keys(buildings) as BuildingKind[]) {
    const r = buildings[k]!;
    transfers.push(r.positions.buffer as ArrayBuffer, r.uvs.buffer as ArrayBuffer, r.indices.buffer as ArrayBuffer);
  }
  for (const k of Object.keys(roads) as RoadKind[]) {
    const r = roads[k]!;
    transfers.push(r.positions.buffer as ArrayBuffer, r.uvs.buffer as ArrayBuffer, r.indices.buffer as ArrayBuffer);
  }

  (self as unknown as Worker).postMessage(out, transfers);
};

export {};
