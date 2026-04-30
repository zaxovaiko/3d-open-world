import { useEffect, useRef, useState } from "react";
import type { TileData } from "../types";
import { fetchTile } from "./overpass";
import { TILE_SIZE, type Projector } from "./project";

const RING = 1; // 3x3 candidate grid; view-cone trims most.
const COS_CONE = -0.4; // ~113° forward cone (keeps current tile + sides + a bit of behind).

type State = Map<string, TileData>;

export function useTileStreamer(
  proj: Projector,
  carPos: { x: number; z: number },
  forward: { x: number; z: number },
): TileData[] {
  const [tiles, setTiles] = useState<State>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const lastDesired = useRef<string>("");

  const tx = Math.floor(carPos.x / TILE_SIZE);
  const tz = Math.floor(carPos.z / TILE_SIZE);

  // Build desired set keyed off (tile, forward octant) so we only re-plan when
  // something meaningful changed.
  const fOct = Math.round(Math.atan2(forward.z, forward.x) / (Math.PI / 4));
  const planKey = `${tx}_${tz}_${fOct}`;

  useEffect(() => {
    if (lastDesired.current === planKey && tiles.size > 0) return;
    lastDesired.current = planKey;

    // Normalize forward (caller passes a 2D vector; degenerate → no filtering).
    const fl = Math.hypot(forward.x, forward.z);
    const fx = fl > 0.001 ? forward.x / fl : 0;
    const fz = fl > 0.001 ? forward.z / fl : 0;

    const desired = new Set<string>();
    // Always include current tile.
    desired.add(`${tx}_${tz}`);
    for (let dx = -RING; dx <= RING; dx++) {
      for (let dz = -RING; dz <= RING; dz++) {
        if (dx === 0 && dz === 0) continue;
        // Include neighbors that lie within the camera-forward cone.
        const len = Math.hypot(dx, dz);
        const ndx = dx / len;
        const ndz = dz / len;
        const dot = ndx * fx + ndz * fz;
        if (fl < 0.001 || dot >= COS_CONE) {
          desired.add(`${tx + dx}_${tz + dz}`);
        }
      }
    }

    setTiles((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!desired.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    for (const key of desired) {
      if (tiles.has(key) || inFlight.current.has(key)) continue;
      const [sx, sz] = key.split("_").map(Number);
      inFlight.current.add(key);
      fetchTile(sx, sz, proj)
        .then((td) => {
          setTiles((prev) => {
            const next = new Map(prev);
            next.set(key, td);
            return next;
          });
        })
        .catch((err) => console.warn("tile fetch failed", key, err))
        .finally(() => inFlight.current.delete(key));
    }
  }, [planKey, tx, tz, forward.x, forward.z, proj, tiles]);

  return Array.from(tiles.values());
}
