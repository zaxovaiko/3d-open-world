import { get, set } from "idb-keyval";
import type { OverpassResponse, OsmWay, OsmNode, RoadKind, TileData, TileKey } from "../types";
import { tileBoundsLatLon, type Projector } from "./project";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const CACHE_VERSION = "v3";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

type CacheEntry = { ts: number; data: OverpassResponse };

function tileKey(tx: number, tz: number): TileKey {
  return `${tx}_${tz}`;
}

function cacheKey(tx: number, tz: number, originLat: number, originLon: number): string {
  // Origin is part of key because tile coords depend on origin.
  const olat = originLat.toFixed(4);
  const olon = originLon.toFixed(4);
  return `${CACHE_VERSION}:${olat},${olon}:${tx}_${tz}`;
}

function buildQuery(b: { south: number; west: number; north: number; east: number }): string {
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:25];
(
  way["building"](${bbox});
  way["highway"](${bbox});
  way["railway"="tram"](${bbox});
  way["waterway"](${bbox});
  node["natural"="tree"](${bbox});
  node["natural"="peak"](${bbox});
);
out geom;`;
}

async function fetchOverpass(query: string, signal?: AbortSignal): Promise<OverpassResponse> {
  let lastErr: unknown;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`overpass ${ep} ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      return (await res.json()) as OverpassResponse;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all overpass endpoints failed");
}

class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((r) => this.queue.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const n = this.queue.shift();
      if (n) n();
    }
  }
}

const limiter = new Limiter(2);

export async function fetchTile(
  tx: number,
  tz: number,
  proj: Projector,
  signal?: AbortSignal,
): Promise<TileData> {
  const ck = cacheKey(tx, tz, proj.origin.lat, proj.origin.lon);
  const cached = (await get(ck)) as CacheEntry | undefined;
  let data: OverpassResponse;
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    data = cached.data;
  } else {
    const bounds = tileBoundsLatLon(tx, tz, proj);
    const query = buildQuery(bounds);
    data = await limiter.run(() => fetchOverpass(query, signal));
    await set(ck, { ts: Date.now(), data } satisfies CacheEntry).catch(() => {});
  }

  const buildings: OsmWay[] = [];
  const roads: Record<RoadKind, OsmWay[]> = {
    car: [],
    bike: [],
    bus: [],
    tram: [],
    footway: [],
    river: [],
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

  return { key: tileKey(tx, tz), tx, tz, buildings, roads, trees, peaks };
}

export { tileKey };
