import type { LatLon } from "../types";

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON_EQ = 111320;

export type Projector = {
  origin: LatLon;
  toLocal: (lat: number, lon: number) => { x: number; z: number };
  toLatLon: (x: number, z: number) => LatLon;
  metersPerDegLon: number;
};

export function makeProjector(origin: LatLon): Projector {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const metersPerDegLon = M_PER_DEG_LON_EQ * cosLat;
  return {
    origin,
    metersPerDegLon,
    toLocal: (lat, lon) => ({
      x: (lon - origin.lon) * metersPerDegLon,
      z: -(lat - origin.lat) * M_PER_DEG_LAT,
    }),
    toLatLon: (x, z) => ({
      lat: origin.lat - z / M_PER_DEG_LAT,
      lon: origin.lon + x / metersPerDegLon,
    }),
  };
}

export const TILE_SIZE = 500; // meters

export function tileForPosition(x: number, z: number): { tx: number; tz: number } {
  return {
    tx: Math.floor(x / TILE_SIZE),
    tz: Math.floor(z / TILE_SIZE),
  };
}

export function tileBoundsLatLon(
  tx: number,
  tz: number,
  proj: Projector,
): { south: number; west: number; north: number; east: number } {
  const x0 = tx * TILE_SIZE;
  const x1 = (tx + 1) * TILE_SIZE;
  const z0 = tz * TILE_SIZE;
  const z1 = (tz + 1) * TILE_SIZE;
  const a = proj.toLatLon(x0, z0);
  const b = proj.toLatLon(x1, z1);
  return {
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
    west: Math.min(a.lon, b.lon),
    east: Math.max(a.lon, b.lon),
  };
}
