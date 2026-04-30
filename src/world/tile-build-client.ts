import * as THREE from "three";
import type { TileData, RoadKind } from "../types";
import type { BuildingAABB, BuildingKind } from "./buildings-shared";
import type { TreeInstance } from "./trees";
import type { PeakInstance } from "./peaks";
import TileWorker from "./tile-worker?worker";
import type { WorkerInput, WorkerOutput } from "./tile-worker";

export type BuildingMesh = {
  geometry: THREE.BufferGeometry;
  count: number;
  aabbs: BuildingAABB[];
};

export type Built = {
  buildings: Partial<Record<BuildingKind, BuildingMesh>>;
  roads: Partial<Record<RoadKind, THREE.BufferGeometry>>;
  trees: TreeInstance[];
  peaks: PeakInstance[];
};

let worker: Worker | null = null;
let nextReqId = 1;
const pending = new Map<number, (out: WorkerOutput) => void>();

// Worker replies arrive in bursts when many tiles complete simultaneously.
// Drain the queue at most one tile per animation frame so geometry creation +
// GPU upload work spreads across frames instead of stalling the main thread.
const replyQueue: WorkerOutput[] = [];
let rafScheduled = false;

function drainOne() {
  rafScheduled = false;
  const out = replyQueue.shift();
  if (out) {
    const cb = pending.get(out.reqId);
    if (cb) {
      pending.delete(out.reqId);
      cb(out);
    }
  }
  if (replyQueue.length > 0) {
    rafScheduled = true;
    requestAnimationFrame(drainOne);
  }
}

// Persistent in-memory cache of built tile geometries. Survives tile unmount/remount
// (e.g. car turns away then back). Avoids worker round-trip + geometry rebuild.
const builtCache = new Map<string, Built>();
const inFlightCache = new Map<string, Promise<Built>>();
const BUILT_CACHE_LIMIT = 80;

function builtKey(originLat: number, originLon: number, tx: number, tz: number): string {
  return `${originLat.toFixed(4)},${originLon.toFixed(4)}:${tx}_${tz}`;
}

function touchLRU(key: string, value: Built) {
  builtCache.delete(key);
  builtCache.set(key, value);
  if (builtCache.size > BUILT_CACHE_LIMIT) {
    const first = builtCache.keys().next().value;
    if (first !== undefined) builtCache.delete(first);
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new TileWorker();
  worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
    replyQueue.push(e.data);
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(drainOne);
    }
  };
  return worker;
}

// Wire pre-computed worker buffers into a BufferGeometry. No CPU math here —
// normals + bounding sphere come from the worker.
type RawNormals = {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  bsphere: { cx: number; cy: number; cz: number; radius: number };
};
type RawNoNormals = {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  bsphere: { cx: number; cy: number; cz: number; radius: number };
};

function attachSphere(g: THREE.BufferGeometry, bs: RawNoNormals["bsphere"]) {
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(bs.cx, bs.cy, bs.cz), bs.radius);
}

function buildingGeometry(raw: RawNormals): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(raw.positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(raw.uvs, 2));
  g.setAttribute("normal", new THREE.BufferAttribute(raw.normals, 3));
  g.setIndex(new THREE.BufferAttribute(raw.indices, 1));
  attachSphere(g, raw.bsphere);
  return g;
}

function roadGeometry(raw: RawNoNormals): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(raw.positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(raw.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(raw.indices, 1));
  attachSphere(g, raw.bsphere);
  return g;
}

export function buildTileInWorker(
  tile: TileData,
  origin: { lat: number; lon: number },
): { promise: Promise<Built>; cancel: () => void } {
  const cacheKey = builtKey(origin.lat, origin.lon, tile.tx, tile.tz);

  // Already built? Reuse instantly.
  const cached = builtCache.get(cacheKey);
  if (cached) {
    touchLRU(cacheKey, cached);
    return { promise: Promise.resolve(cached), cancel: () => {} };
  }

  // Already building (e.g. neighbor mount fired in same tick)? Share the in-flight build.
  const inflight = inFlightCache.get(cacheKey);
  if (inflight) {
    let cancelled = false;
    return {
      promise: new Promise<Built>((resolve, reject) => {
        inflight.then(
          (b) => (cancelled ? reject(new Error("cancelled")) : resolve(b)),
          (e) => reject(e),
        );
      }),
      cancel: () => {
        cancelled = true;
      },
    };
  }

  const w = getWorker();
  const reqId = nextReqId++;
  let cancelled = false;
  const promise = new Promise<Built>((resolve, reject) => {
    pending.set(reqId, (out) => {
      const buildings: Partial<Record<BuildingKind, BuildingMesh>> = {};
      for (const k of Object.keys(out.buildings) as BuildingKind[]) {
        const r = out.buildings[k]!;
        buildings[k] = {
          geometry: buildingGeometry(r),
          count: r.count,
          aabbs: r.aabbs,
        };
      }
      const roads: Partial<Record<RoadKind, THREE.BufferGeometry>> = {};
      for (const k of Object.keys(out.roads) as RoadKind[]) {
        roads[k] = roadGeometry(out.roads[k]!);
      }
      const built: Built = { buildings, roads, trees: out.trees, peaks: out.peaks };
      touchLRU(cacheKey, built);
      inFlightCache.delete(cacheKey);
      if (cancelled) return reject(new Error("cancelled"));
      resolve(built);
    });
  });
  inFlightCache.set(cacheKey, promise.catch(() => builtCache.get(cacheKey)!));
  const msg: WorkerInput = {
    reqId,
    tx: tile.tx,
    tz: tile.tz,
    data: tile.data,
    originLat: origin.lat,
    originLon: origin.lon,
  };
  w.postMessage(msg);
  return {
    promise,
    cancel: () => {
      // Mark cancelled but allow worker result to populate cache so next mount is instant.
      cancelled = true;
    },
  };
}
