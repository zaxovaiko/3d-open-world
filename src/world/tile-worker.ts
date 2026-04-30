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
    highway: [], road: [], street: [], service: [],
    bike: [], bus: [], tram: [], footway: [], river: [],
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
      } else if (t.railway === "tram" || t.railway === "rail" || t.railway === "light_rail") {
        roads.tram.push(el);
      } else if (t.highway) {
        const h = t.highway;
        if (h === "cycleway") roads.bike.push(el);
        else if (h === "busway" || t.busway) roads.bus.push(el);
        else if (
          h === "footway" || h === "path" || h === "pedestrian" || h === "steps" ||
          h === "corridor" || h === "track"
        )
          roads.footway.push(el);
        else if (
          h === "motorway" || h === "trunk" || h === "primary" ||
          h === "motorway_link" || h === "trunk_link" || h === "primary_link"
        )
          roads.highway.push(el);
        else if (
          h === "secondary" || h === "tertiary" ||
          h === "secondary_link" || h === "tertiary_link"
        )
          roads.road.push(el);
        else if (h === "service")
          roads.service.push(el);
        else
          // residential, unclassified, living_street, road, etc.
          roads.street.push(el);
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
// Texture repeat in metres. Hi-res textures ship with an 8×10 window grid,
// so 8m × 30m per repeat keeps individual windows ~1m wide × ~3m tall.
const WINDOW_W_M = 8;
const WINDOW_H_M = 30;

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
  // Edges shared exactly with another building (1cm quantization). Both
  // sides drop the wall — provably interior to whichever side touches.
  sharedEdges: Set<string>;
};

function computeOcclusion(prepared: PreparedBuilding[]): Occlusion {
  const edgeCount = new Map<string, number>();
  for (let i = 0; i < prepared.length; i++) {
    const ring = prepared[i].ring;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      const q = ring[(k + 1) % ring.length];
      const key = edgeKey(p.x, p.z, q.x, q.z);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  const sharedEdges = new Set<string>();
  for (const [k, c] of edgeCount) if (c > 1) sharedEdges.add(k);
  return { sharedEdges };
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

      // Drop only walls we can prove are interior partitions: edges shared
      // exactly (1cm quantization) with another building. Point-in-polygon
      // on a midpoint sample false-positives on non-convex neighbours and
      // grazing AABB overlaps, so it is no longer applied.
      if (occ.sharedEdges.has(edgeKey(ax, az, bx, bz))) continue;

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

// Per-OSM-highway widths in metres. ~3.5 m per car lane plus shoulder.
// Values lean on https://wiki.openstreetmap.org/wiki/Key:highway typical
// real-world widths.
const HIGHWAY_WIDTHS: Record<string, number> = {
  motorway: 14, motorway_link: 7,
  trunk: 11, trunk_link: 6,
  primary: 9, primary_link: 5,
  secondary: 8, secondary_link: 5,
  tertiary: 7, tertiary_link: 4.5,
  residential: 6, unclassified: 6, living_street: 5, road: 6,
  service: 4, track: 3.5,
  pedestrian: 3, footway: 2, path: 1.5, cycleway: 2.5, steps: 1.5, corridor: 1.5,
};
const KIND_DEFAULTS: Record<RoadKind, { width: number; y: number; lengthScale: number }> = {
  highway: { width: 14, y: 0.16, lengthScale: 8 },
  road:    { width: 9,  y: 0.15, lengthScale: 8 },
  street:  { width: 6,  y: 0.14, lengthScale: 8 },
  service: { width: 4,  y: 0.13, lengthScale: 6 },
  bike:    { width: 2.2, y: 0.18, lengthScale: 4 },
  bus:     { width: 6,  y: 0.17, lengthScale: 8 },
  tram:    { width: 3,  y: 0.05, lengthScale: 2 },
  footway: { width: 2,  y: 0.12, lengthScale: 3 },
  river:   { width: 8,  y: 0.04, lengthScale: 16 },
};
const CAR_LIKE_KINDS = new Set<RoadKind>(["highway", "road", "street", "service", "bus"]);

function widthFor(kind: RoadKind, w: OsmWay): number {
  // Width is determined ONLY by OSM highway class, not by per-way `lanes`
  // or `width` tags. Adjacent OSM ways representing the same street often
  // disagree on those tags (one segment marked lanes=4, the next no tag),
  // which produced visible width steps along a single street. Forcing a
  // class-based constant keeps a logical road consistent end to end.
  const tags = w.tags;
  if (CAR_LIKE_KINDS.has(kind) && tags?.highway) {
    return HIGHWAY_WIDTHS[tags.highway] ?? KIND_DEFAULTS[kind].width;
  }
  return KIND_DEFAULTS[kind].width;
}

type RoadRaw = {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  bsphere: BSphere;
};

// Miter limit: clamp miter spike length so very sharp angles don't shoot
// far past the joint. 4 = up to 4× halfW. Beyond that we cap.
const MITER_LIMIT = 4;

// Chaikin's corner-cutting algorithm. Each interior vertex is replaced by
// two new vertices at 1/4 and 3/4 along its adjacent edges, smoothing
// sharp OSM angles into curves. Endpoints are preserved.
function chaikinSmooth(pts: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  if (pts.length < 3) return pts;
  const out: Array<{ x: number; z: number }> = [];
  out.push(pts[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function buildRoadsRaw(ways: OsmWay[], proj: Projector, kind: RoadKind): RoadRaw | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vIndex = 0;
  const cfg = KIND_DEFAULTS[kind];
  // Per-way y jitter so two same-kind streets crossing each other don't
  // z-fight on the intersection patch. Range ±2.4 mm — invisible to the
  // player but enough for a stable depth ordering. Polygon clipping for
  // true overlap removal would be far more expensive.
  const Y_JITTER_STEP = 0.0008;

  let wayIdx = 0;
  for (const w of ways) {
    const pts = w.geometry;
    if (pts.length < 2) continue;
    const halfW = widthFor(kind, w) / 2;
    const projected = pts.map((p) => proj.toLocal(p.lat, p.lon));
    // Chaikin corner-cutting: every interior vertex splits into two new
    // points at 1/4 and 3/4 along each adjacent edge, so sharp OSM corners
    // become rounded curves. Two passes is enough; endpoints stay fixed.
    const local = chaikinSmooth(chaikinSmooth(projected));
    const yJitter = (wayIdx % 7 - 3) * Y_JITTER_STEP;
    const yBase = cfg.y + yJitter;
    wayIdx++;

    // Edge normals + lengths between consecutive points (drop degenerate edges).
    type Edge = { nx: number; nz: number; len: number };
    const edges: Edge[] = [];
    const verts: Array<{ x: number; z: number }> = [local[0]];
    for (let i = 0; i < local.length - 1; i++) {
      const a = verts[verts.length - 1];
      const b = local[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      edges.push({ nx: -dz / len, nz: dx / len, len });
      verts.push(b);
    }
    if (edges.length === 0) continue;
    const N = verts.length;

    // Per-vertex miter offset. Shared between adjacent quads → no gap, no
    // self-overlap at interior joints. Endpoints use the single edge normal.
    const offsets: Array<{ ox: number; oz: number }> = new Array(N);
    for (let i = 0; i < N; i++) {
      if (i === 0) {
        const e = edges[0];
        offsets[0] = { ox: e.nx * halfW, oz: e.nz * halfW };
      } else if (i === N - 1) {
        const e = edges[N - 2];
        offsets[i] = { ox: e.nx * halfW, oz: e.nz * halfW };
      } else {
        const a = edges[i - 1], b = edges[i];
        let mx = a.nx + b.nx, mz = a.nz + b.nz;
        const ml = Math.hypot(mx, mz);
        if (ml < 1e-3) {
          // 180° turn — fall back to one edge normal.
          offsets[i] = { ox: b.nx * halfW, oz: b.nz * halfW };
        } else {
          mx /= ml; mz /= ml;
          // dot(miter, edgeNormal) = cos(half-turn-angle); guards against ÷0.
          const d = mx * b.nx + mz * b.nz;
          const scale = Math.min(halfW / Math.max(d, 1e-3), halfW * MITER_LIMIT);
          offsets[i] = { ox: mx * scale, oz: mz * scale };
        }
      }
    }

    // Emit quads. Both ends of each segment use the *shared* miter offset, so
    // consecutive segments meet edge-to-edge (no gap), and the inner side does
    // not overlap.
    let traveled = 0;
    for (let i = 0; i < N - 1; i++) {
      const a = verts[i], b = verts[i + 1];
      const oa = offsets[i], ob = offsets[i + 1];
      const len = edges[i].len;
      const v0 = traveled / cfg.lengthScale;
      const v1 = (traveled + len) / cfg.lengthScale;
      positions.push(a.x + oa.ox, yBase, a.z + oa.oz); uvs.push(0, v0);
      positions.push(a.x - oa.ox, yBase, a.z - oa.oz); uvs.push(1, v0);
      positions.push(b.x + ob.ox, yBase, b.z + ob.oz); uvs.push(0, v1);
      positions.push(b.x - ob.ox, yBase, b.z - ob.oz); uvs.push(1, v1);
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

const ROAD_KINDS: RoadKind[] = [
  "river", "tram", "footway", "bike", "bus", "service", "street", "road", "highway",
];

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
  // Centerlines for `car` roads only — flat (x, z) pairs per way. Used by
  // AI traffic to follow streets without re-parsing geometry on the main thread.
  carRoadCenterlines: Float32Array[];
  tramCenterlines: Float32Array[];
  // Roadside guard-rail barrier instances along highway+road edges. Flat
  // (x, z, yaw) triples — one InstancedMesh on the main thread renders all
  // of them as small concrete blocks.
  barrierInstances: Float32Array;
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

  // Car-road centerlines for AI driving. Smoothed with the same Chaikin pass
  // applied to road geometry so AI traffic follows the curves the player sees
  // instead of cutting corners on the original OSM polyline. All car-driveable
  // sub-classes feed the same AI pool.
  const carRoadCenterlines: Float32Array[] = [];
  const tramCenterlines: Float32Array[] = [];
  const collectCenterlines = (ways: OsmWay[], out: Float32Array[]) => {
    for (const w of ways) {
      const pts = w.geometry;
      if (pts.length < 2) continue;
      const projected = pts.map((p) => proj.toLocal(p.lat, p.lon));
      const smoothed = chaikinSmooth(chaikinSmooth(projected));
      const arr = new Float32Array(smoothed.length * 2);
      for (let i = 0; i < smoothed.length; i++) {
        arr[i * 2] = smoothed[i].x;
        arr[i * 2 + 1] = smoothed[i].z;
      }
      out.push(arr);
    }
  };
  collectCenterlines(classified.roads.highway, carRoadCenterlines);
  collectCenterlines(classified.roads.road, carRoadCenterlines);
  collectCenterlines(classified.roads.street, carRoadCenterlines);
  collectCenterlines(classified.roads.service, carRoadCenterlines);
  collectCenterlines(classified.roads.tram, tramCenterlines);

  // Roadside barriers: every BARRIER_STEP metres along highway+road, place a
  // concrete block on each side just past the carriageway edge. Skip small
  // streets / service roads where a guard rail wouldn't read.
  const BARRIER_STEP = 18;
  const BARRIER_OFFSET = 0.6;
  const barrierFloats: number[] = [];
  const collectBarriers = (ways: OsmWay[], kind: RoadKind) => {
    const cfg = KIND_DEFAULTS[kind];
    for (const w of ways) {
      const halfW = widthFor(kind, w) / 2 + BARRIER_OFFSET;
      const projected = w.geometry.map((p) => proj.toLocal(p.lat, p.lon));
      const smoothed = chaikinSmooth(chaikinSmooth(projected));
      let acc = 0;
      let nextEmit = BARRIER_STEP / 2;
      for (let i = 0; i < smoothed.length - 1; i++) {
        const a = smoothed[i], b = smoothed[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.001) continue;
        const nx = -dz / len, nz = dx / len;
        const yaw = Math.atan2(dx, dz);
        while (acc + len >= nextEmit) {
          const t = (nextEmit - acc) / len;
          const cx = a.x + dx * t;
          const cz = a.z + dz * t;
          // Left + right.
          barrierFloats.push(cx + nx * halfW, cz + nz * halfW, yaw);
          barrierFloats.push(cx - nx * halfW, cz - nz * halfW, yaw);
          nextEmit += BARRIER_STEP;
        }
        acc += len;
      }
      // Suppress unused-var lint (cfg reserved for future per-kind tuning).
      void cfg;
    }
  };
  collectBarriers(classified.roads.highway, "highway");
  collectBarriers(classified.roads.road, "road");
  const barrierInstances = new Float32Array(barrierFloats);

  const out: WorkerOutput = {
    reqId, buildings, roads, trees, peaks, carRoadCenterlines, tramCenterlines, barrierInstances,
  };

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
  for (const cl of carRoadCenterlines) transfers.push(cl.buffer as ArrayBuffer);
  for (const cl of tramCenterlines) transfers.push(cl.buffer as ArrayBuffer);
  transfers.push(barrierInstances.buffer as ArrayBuffer);

  (self as unknown as Worker).postMessage(out, transfers);
};

export {};
