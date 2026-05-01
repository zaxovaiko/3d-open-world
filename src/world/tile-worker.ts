/// <reference lib="webworker" />
import earcut from "earcut";
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

// --- Overpass classification (mirrors what fetchTile used to do on main thread) ---

export type PoiKind = "lamp" | "bench" | "mailbox" | "hydrant" | "signpost";

type ClassifiedTile = {
  buildings: OsmWay[];
  roads: Record<RoadKind, OsmWay[]>;
  trees: OsmNode[];
  peaks: OsmNode[];
  pois: Record<PoiKind, OsmNode[]>;
  // Closed-polygon water rings (lakes/ponds/reservoirs/riverbanks). Each
  // entry is an outer ring in lon/lat space.
  waterPolys: OsmGeomLatLon[][];
};

type OsmGeomLatLon = { lat: number; lon: number };

function isWaterAreaTags(t: Record<string, string> | undefined): boolean {
  if (!t) return false;
  if (t.natural === "water") return true;
  if (t.water) return true;
  if (t.landuse === "reservoir" || t.landuse === "basin") return true;
  if (t.waterway === "riverbank" || t.waterway === "dock") return true;
  return false;
}

// Assemble multipolygon outer rings from a set of way segments by chaining
// segments that share endpoints. Inner rings (holes) ignored — water bodies
// with islands render as solid water; islands are approximate.
function assembleRings(segments: OsmGeomLatLon[][]): OsmGeomLatLon[][] {
  const rings: OsmGeomLatLon[][] = [];
  const remaining = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const eq = (a: OsmGeomLatLon, b: OsmGeomLatLon) => a.lat === b.lat && a.lon === b.lon;
  while (remaining.length) {
    const ring = remaining.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      const tail = ring[ring.length - 1];
      const head = ring[0];
      if (eq(tail, head) && ring.length > 3) break;
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (eq(tail, seg[0])) {
          for (let k = 1; k < seg.length; k++) ring.push(seg[k]);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (eq(tail, seg[seg.length - 1])) {
          for (let k = seg.length - 2; k >= 0; k--) ring.push(seg[k]);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (eq(head, seg[seg.length - 1])) {
          for (let k = seg.length - 2; k >= 0; k--) ring.unshift(seg[k]);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (eq(head, seg[0])) {
          for (let k = 1; k < seg.length; k++) ring.unshift(seg[k]);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    if (ring.length >= 4 && eq(ring[0], ring[ring.length - 1])) {
      rings.push(ring);
    }
  }
  return rings;
}

function classifyElements(data: OverpassResponse): ClassifiedTile {
  const buildings: OsmWay[] = [];
  const roads: Record<RoadKind, OsmWay[]> = {
    highway: [], road: [], street: [], service: [],
    bike: [], bus: [], tram: [], footway: [], river: [],
  };
  const trees: OsmNode[] = [];
  const peaks: OsmNode[] = [];
  const pois: Record<PoiKind, OsmNode[]> = {
    lamp: [], bench: [], mailbox: [], hydrant: [], signpost: [],
  };
  const waterPolys: OsmGeomLatLon[][] = [];

  for (const el of data.elements) {
    if (el.type === "way" && el.geometry?.length) {
      const t = el.tags ?? {};
      const closed =
        el.geometry.length >= 4 &&
        el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat &&
        el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;
      if (t.building) {
        buildings.push(el);
      } else if (closed && isWaterAreaTags(t)) {
        waterPolys.push(el.geometry.slice(0, -1));
      } else if (t.waterway && !isWaterAreaTags(t)) {
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
      const t = el.tags ?? {};
      if (t.natural === "tree") trees.push(el);
      else if (t.natural === "peak") peaks.push(el);
      else if (t.highway === "street_lamp") pois.lamp.push(el);
      else if (t.amenity === "bench") pois.bench.push(el);
      else if (t.amenity === "post_box") pois.mailbox.push(el);
      else if (t.emergency === "fire_hydrant") pois.hydrant.push(el);
      else if (t.traffic_sign) pois.signpost.push(el);
    } else if (el.type === "relation") {
      const t = el.tags ?? {};
      if (!isWaterAreaTags(t)) continue;
      const outerSegs: OsmGeomLatLon[][] = [];
      for (const m of el.members) {
        if (m.type !== "way" || !m.geometry?.length) continue;
        if (m.role && m.role !== "outer") continue;
        outerSegs.push(m.geometry);
      }
      const rings = assembleRings(outerSegs);
      for (const r of rings) waterPolys.push(r.slice(0, -1));
    }
  }
  return { buildings, roads, trees, peaks, pois, waterPolys };
}

// --- Building build (typed arrays) ---

const DEFAULT_HEIGHT = 8;

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

// Per-kind AABB list. Buildings are rendered as instanced GLB models on the
// main thread, sized + positioned from these AABBs — no per-tile geometry
// transferred from the worker.
type BuildingRaw = {
  aabbs: BuildingAABB[];
};

type PreparedBuilding = {
  kind: BuildingKind;
  aabb: BuildingAABB;
};

function prepareBuilding(w: OsmWay, kind: BuildingKind, proj: Projector): PreparedBuilding | null {
  const pts = w.geometry;
  if (pts.length < 4) return null;
  const closed =
    pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon;
  const raw = closed ? pts.slice(0, -1) : pts;
  if (raw.length < 3) return null;

  const ring: Pt[] = raw.map((p) => proj.toLocal(p.lat, p.lon));
  if (Math.abs(signedArea(ring)) < 1) return null;

  const h = parseHeight(w.tags);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return {
    kind,
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

function buildBuildingsRawFromPrepared(
  prepared: PreparedBuilding[],
  kind: BuildingKind,
): BuildingRaw | null {
  const aabbs: BuildingAABB[] = [];
  for (let bi = 0; bi < prepared.length; bi++) {
    const b = prepared[bi];
    if (b.kind !== kind) continue;
    aabbs.push(b.aabb);
  }
  return aabbs.length ? { aabbs } : null;
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
  // Tram sits above all road kinds so rails always draw on top of asphalt.
  tram:    { width: 3,  y: 0.22, lengthScale: 2 },
  footway: { width: 2,  y: 0.12, lengthScale: 3 },
  river:   { width: 12, y: 0.04, lengthScale: 16 },
};
const CAR_LIKE_KINDS = new Set<RoadKind>(["highway", "road", "street", "service", "bus"]);
// Standard lane width (m). OSM `lanes` tag * this value = drawn road width.
const LANE_WIDTH_M = 3.5;

function widthFor(kind: RoadKind, w: OsmWay): number {
  const tags = w.tags;
  // Rivers / waterways: respect OSM `width` tag — real river widths vary
  // wildly and the tag is the source of truth. Fall back to waterway-class
  // defaults: river 12 m, stream 4 m, canal 8 m.
  if (kind === "river") {
    if (tags?.width) {
      const v = parseFloat(tags.width);
      if (Number.isFinite(v) && v > 0) return v;
    }
    if (tags?.waterway === "stream") return 4;
    if (tags?.waterway === "canal") return 8;
    if (tags?.waterway === "river") return 14;
    return KIND_DEFAULTS.river.width;
  }
  // Roads: prefer OSM `lanes` tag — exact lane count drives drawn width.
  // Falls back to highway-class default when `lanes` is missing or invalid.
  if (CAR_LIKE_KINDS.has(kind)) {
    if (tags?.lanes) {
      const lanes = parseFloat(tags.lanes);
      if (Number.isFinite(lanes) && lanes > 0) return lanes * LANE_WIDTH_M;
    }
    if (tags?.highway) {
      return HIGHWAY_WIDTHS[tags.highway] ?? KIND_DEFAULTS[kind].width;
    }
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
// Narrow paths (footway/bike) are jaggier in OSM and any miter spike past
// ~1.5× halfW reads as a visible kink at typical viewing distance, so they
// use a tighter cap.
const NARROW_MITER_LIMIT = 1.5;
const NARROW_KINDS = new Set<RoadKind>(["footway", "bike"]);

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

  const isNarrow = NARROW_KINDS.has(kind);
  const miterLimit = isNarrow ? NARROW_MITER_LIMIT : MITER_LIMIT;

  let wayIdx = 0;
  for (const w of ways) {
    const pts = w.geometry;
    if (pts.length < 2) continue;
    const halfW = widthFor(kind, w) / 2;
    const projected = pts.map((p) => proj.toLocal(p.lat, p.lon));
    // Chaikin corner-cutting: every interior vertex splits into two new
    // points at 1/4 and 3/4 along each adjacent edge. Narrow paths get two
    // extra passes so the per-vertex miter offsets blend smoothly instead
    // of leaving a fishbone silhouette.
    let local = chaikinSmooth(chaikinSmooth(projected));
    if (isNarrow) local = chaikinSmooth(chaikinSmooth(local));
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
          const scale = Math.min(halfW / Math.max(d, 1e-3), halfW * miterLimit);
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

// --- Water polygon mesh (flat triangulation via earcut) ---

const WATER_AREA_Y = 0.04;
const WATER_TEX_SCALE = 16;

function buildWaterAreaMesh(
  polys: OsmGeomLatLon[][],
  proj: Projector,
): RoadRaw | null {
  if (!polys.length) return null;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vIndex = 0;
  for (const ring of polys) {
    if (ring.length < 3) continue;
    const flat: number[] = [];
    for (const p of ring) {
      const xz = proj.toLocal(p.lat, p.lon);
      flat.push(xz.x, xz.z);
    }
    const tris = earcut(flat);
    if (!tris.length) continue;
    const base = vIndex;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i], z = flat[i + 1];
      positions.push(x, WATER_AREA_Y, z);
      uvs.push(x / WATER_TEX_SCALE, z / WATER_TEX_SCALE);
      vIndex++;
    }
    for (const ti of tris) indices.push(base + ti);
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
  waterArea: RoadRaw | null;
  trees: TreeInstance[];
  peaks: PeakInstance[];
  // Centerlines for `car` roads only — flat (x, z) pairs per way. Used by
  // AI traffic to follow streets without re-parsing geometry on the main thread.
  carRoadCenterlines: Float32Array[];
  tramCenterlines: Float32Array[];
  // Water (river/stream/canal) centerlines + parallel half-widths.
  // Used by the grass system to skip blades over water.
  waterCenterlines: Float32Array[];
  waterHalfWidths: Float32Array;
  // Per-kind POI positions. Flat (x, z) pairs per kind. Rendered as
  // InstancedMesh per kind on the main thread using GLB models.
  pois: Record<PoiKind, Float32Array>;
};

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const { reqId, data, originLat, originLon } = e.data;
  const proj = makeProjector({ lat: originLat, lon: originLon });

  // Classify Overpass elements (was on main thread in fetchTile).
  const classified = classifyElements(data);

  // Project + classify each building footprint into an AABB. The AABB drives
  // GLB instance placement on the main thread (scale + position).
  const prepared: PreparedBuilding[] = [];
  for (const w of classified.buildings) {
    const kind = _classifyBuilding(w.tags);
    const p = prepareBuilding(w, kind, proj);
    if (p) prepared.push(p);
  }
  const buildings: Partial<Record<BuildingKind, BuildingRaw>> = {};
  for (const k of BUILDING_KINDS) {
    const r = buildBuildingsRawFromPrepared(prepared, k);
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

  // Water centerlines + half-widths: per-way half-width derived from the
  // same widthFor() the visible mesh uses, so the grass mask matches the
  // rendered river footprint exactly.
  const waterCenterlines: Float32Array[] = [];
  const waterHalfWidthsArr: number[] = [];
  for (const w of classified.roads.river) {
    const pts = w.geometry;
    if (pts.length < 2) continue;
    const projected = pts.map((p) => proj.toLocal(p.lat, p.lon));
    const smoothed = chaikinSmooth(chaikinSmooth(projected));
    const arr = new Float32Array(smoothed.length * 2);
    for (let i = 0; i < smoothed.length; i++) {
      arr[i * 2] = smoothed[i].x;
      arr[i * 2 + 1] = smoothed[i].z;
    }
    waterCenterlines.push(arr);
    waterHalfWidthsArr.push(widthFor("river", w) / 2);
  }
  const waterHalfWidths = new Float32Array(waterHalfWidthsArr);

  // Water-area polygons (lakes/ponds/reservoirs/riverbanks): triangulate each
  // outer ring with earcut and emit as a single flat mesh at river y-level.
  // UVs use a simple xz / TILE projection so the water texture tiles uniformly.
  const waterArea = buildWaterAreaMesh(classified.waterPolys, proj);

  // POIs: project each node and pack flat (x, z) pairs per kind.
  const poiKinds: PoiKind[] = ["lamp", "bench", "mailbox", "hydrant", "signpost"];
  const poisOut = {} as Record<PoiKind, Float32Array>;
  for (const k of poiKinds) {
    const nodes = classified.pois[k];
    const arr = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      const p = proj.toLocal(nodes[i].lat, nodes[i].lon);
      arr[i * 2] = p.x;
      arr[i * 2 + 1] = p.z;
    }
    poisOut[k] = arr;
  }

  const out: WorkerOutput = {
    reqId, buildings, roads, waterArea, trees, peaks,
    carRoadCenterlines, tramCenterlines,
    waterCenterlines, waterHalfWidths,
    pois: poisOut,
  };

  // Collect transferable buffers — zero-copy transfer to main thread.
  // Buildings ship as plain AABB structs (no typed arrays), so nothing to transfer.
  const transfers: Transferable[] = [];
  for (const k of Object.keys(roads) as RoadKind[]) {
    const r = roads[k]!;
    transfers.push(r.positions.buffer as ArrayBuffer, r.uvs.buffer as ArrayBuffer, r.indices.buffer as ArrayBuffer);
  }
  if (waterArea) {
    transfers.push(
      waterArea.positions.buffer as ArrayBuffer,
      waterArea.uvs.buffer as ArrayBuffer,
      waterArea.indices.buffer as ArrayBuffer,
    );
  }
  for (const cl of carRoadCenterlines) transfers.push(cl.buffer as ArrayBuffer);
  for (const cl of tramCenterlines) transfers.push(cl.buffer as ArrayBuffer);
  for (const cl of waterCenterlines) transfers.push(cl.buffer as ArrayBuffer);
  transfers.push(waterHalfWidths.buffer as ArrayBuffer);
  for (const k of poiKinds) transfers.push(poisOut[k].buffer as ArrayBuffer);

  (self as unknown as Worker).postMessage(out, transfers);
};

export {};
