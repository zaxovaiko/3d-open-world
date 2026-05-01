import { get, set } from "idb-keyval";
import type { OverpassResponse, TileData, TileKey } from "../types";
import { tileBoundsLatLon, type Projector } from "./project";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const CACHE_VERSION = "v8";
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
  way["natural"="water"](${bbox});
  way["water"](${bbox});
  way["landuse"="reservoir"](${bbox});
  way["landuse"="basin"](${bbox});
  relation["natural"="water"](${bbox});
  relation["waterway"="riverbank"](${bbox});
  relation["water"](${bbox});
  node["natural"="tree"](${bbox});
  node["natural"="peak"](${bbox});
  node["highway"="street_lamp"](${bbox});
  node["amenity"="bench"](${bbox});
  node["amenity"="post_box"](${bbox});
  node["emergency"="fire_hydrant"](${bbox});
  node["traffic_sign"](${bbox});
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

// Network + idb only. Element classification happens inside the worker.
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
    // Fire-and-forget cache write — never block the main thread on idb.
    set(ck, { ts: Date.now(), data } satisfies CacheEntry).catch(() => {});
  }
  return { key: tileKey(tx, tz), tx, tz, data };
}

export { tileKey };
