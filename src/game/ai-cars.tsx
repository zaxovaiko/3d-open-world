import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import type { BuiltEntry } from "./world-meshes";

const COUNT = 14;
const SPEED = 9; // m/s ~32 km/h
const SPAWN_RADIUS = 500; // first-spawn search radius
const DESPAWN_RADIUS = 1100; // very lenient — cars only recycle when far past fog
const HIDDEN_Y = -200;
const MIN_GAP_M = 14;
const SLOW_GAP_M = 26;
const REPLAN_PADDING = 8;
const ENDPOINT_GRID_M = 2; // endpoint quantization for connectivity graph

type AIState = {
  body: RapierRigidBody | null;
  way: Float32Array | null; // active polyline (may be a reversed view)
  segIdx: number;
  t: number;
  arc: number; // distance along `way` from way[0] to current position
};

type Props = {
  built: BuiltEntry[];
  // Player position ref so spawn/despawn logic can query without re-rendering.
  playerPosRef: React.RefObject<{ pos: THREE.Vector3 } | null>;
};

const COLORS = ["#1f6feb", "#2da44e", "#bf8700", "#cf222e", "#8250df", "#0a3069", "#9a6700", "#444c56"];

export function AICars({ built, playerPosRef }: Props) {
  // Per-tile centerlines accumulated into a flat pool, plus a way-endpoint
  // graph so cars can follow connected streets across intersections instead
  // of teleporting back near the player when their current way ends.
  const { ways, lens, endpointMap } = useMemo(() => {
    const out: Float32Array[] = [];
    for (const e of built) for (const w of e.data.carRoadCenterlines) out.push(w);
    const lengths = out.map(wayLength);

    // Map quantized "x,z" key → list of (way, atStart). Two adjacent streets
    // sharing an OSM node land on the same key.
    const map = new Map<string, Array<{ way: Float32Array; atStart: boolean }>>();
    for (const w of out) {
      if (w.length < 4) continue;
      const N = w.length / 2;
      const sk = endKey(w[0], w[1]);
      const ek = endKey(w[(N - 1) * 2], w[(N - 1) * 2 + 1]);
      if (!map.has(sk)) map.set(sk, []);
      map.get(sk)!.push({ way: w, atStart: true });
      if (!map.has(ek)) map.set(ek, []);
      map.get(ek)!.push({ way: w, atStart: false });
    }
    return { ways: out, lens: lengths, endpointMap: map };
  }, [built]);

  const waysRef = useRef(ways);
  const lensRef = useRef(lens);
  const endpointMapRef = useRef(endpointMap);
  // Reversed-way cache so following a connected way that joins at its END
  // is still a forward iteration. Lives across tile loads — `built` ref
  // identities change but the underlying Float32Array references stay alive
  // as long as a car holds them.
  const reversedCacheRef = useRef(new WeakMap<Float32Array, Float32Array>());

  useEffect(() => {
    waysRef.current = ways;
    lensRef.current = lens;
    endpointMapRef.current = endpointMap;
  }, [ways, lens, endpointMap]);

  const carsRef = useRef<AIState[]>(
    Array.from({ length: COUNT }, () => ({ body: null, way: null, segIdx: 0, t: 0, arc: 0 })),
  );

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, dt) => {
    const cars = carsRef.current;
    const ws = waysRef.current;
    if (ws.length === 0) return;
    const player = playerPosRef.current?.pos;
    const px = player?.x ?? 0, pz = player?.z ?? 0;

    // Pre-compute current arc for spacing checks.
    for (const c of cars) {
      if (c.way) c.arc = arcLength(c.way, c.segIdx, c.t);
    }

    for (const c of cars) {
      if (!c.body) continue;
      const tr = c.body.translation();
      const distToPlayer = Math.hypot(tr.x - px, tr.z - pz);

      // Distance recycle is intentionally generous — cars stay alive far
      // past the visible fog so the player can drive back and find them.
      if (!c.way || distToPlayer > DESPAWN_RADIUS) {
        const slot = findSpawnSlot(ws, lensRef.current, cars, c, px, pz, SPAWN_RADIUS);
        if (!slot) {
          c.way = null;
          c.body.setNextKinematicTranslation({ x: tr.x, y: HIDDEN_Y, z: tr.z });
          continue;
        }
        applySpawn(c, slot.way, slot.segIdx, slot.t);
        const w = slot.way;
        const ax = w[c.segIdx * 2], az = w[c.segIdx * 2 + 1];
        const bx = w[(c.segIdx + 1) * 2], bz = w[(c.segIdx + 1) * 2 + 1];
        const fx = ax + (bx - ax) * c.t;
        const fz = az + (bz - az) * c.t;
        c.body.setTranslation({ x: fx, y: 0.6, z: fz }, true);
        continue;
      }

      // Spacing — slow down behind any car ahead on the same way.
      let aheadGap = Infinity;
      for (const o of cars) {
        if (o === c || o.way !== c.way) continue;
        const gap = o.arc - c.arc;
        if (gap > 0 && gap < aheadGap) aheadGap = gap;
      }
      let speed = SPEED;
      if (aheadGap < SLOW_GAP_M) {
        if (aheadGap <= MIN_GAP_M) speed = 0;
        else speed = SPEED * (aheadGap - MIN_GAP_M) / (SLOW_GAP_M - MIN_GAP_M);
      }

      const w = c.way;
      const N = w.length / 2;
      const ax = w[c.segIdx * 2], az = w[c.segIdx * 2 + 1];
      const bx = w[(c.segIdx + 1) * 2], bz = w[(c.segIdx + 1) * 2 + 1];
      const segLen = Math.hypot(bx - ax, bz - az) || 1;
      c.t += (speed * dt) / segLen;
      while (c.t >= 1 && c.segIdx < N - 2) {
        c.t -= 1;
        c.segIdx++;
      }

      if (c.t >= 1 && c.segIdx >= N - 2) {
        // Reached end of way. Try to continue onto a connected way so the
        // car keeps driving instead of teleporting.
        const lx = w[(N - 1) * 2], lz = w[(N - 1) * 2 + 1];
        const next = pickConnectedWay(endpointMapRef.current, w, lx, lz, reversedCacheRef.current);
        if (next) {
          applySpawn(c, next, 0, 0);
          continue;
        }
        c.way = null;
        continue;
      }

      const ux = w[c.segIdx * 2], uz = w[c.segIdx * 2 + 1];
      const vx = w[(c.segIdx + 1) * 2], vz = w[(c.segIdx + 1) * 2 + 1];
      const tx = ux + (vx - ux) * c.t;
      const tz = uz + (vz - uz) * c.t;
      const dx = vx - ux, dz = vz - uz;
      const yaw = Math.atan2(dx, dz);

      c.body.setNextKinematicTranslation({ x: tx, y: 0.6, z: tz });
      tmpQ.setFromAxisAngle(tmpAxis, yaw);
      c.body.setNextKinematicRotation({ x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w });
    }
  });

  return (
    <>
      {carsRef.current.map((c, i) => (
        <RigidBody
          key={i}
          ref={(b: RapierRigidBody | null) => {
            c.body = b;
          }}
          type="kinematicPosition"
          colliders={false}
          position={[0, HIDDEN_Y, 0]}
          ccd
        >
          <CuboidCollider args={[0.9, 0.6, 2]} restitution={0.05} friction={0.5} />
          <mesh castShadow={false}>
            <boxGeometry args={[1.8, 1.2, 4]} />
            <meshLambertMaterial color={COLORS[i % COLORS.length]} />
          </mesh>
          <mesh position={[0, 0.7, -0.4]}>
            <boxGeometry args={[1.6, 0.6, 1.8]} />
            <meshLambertMaterial color="#1a1a1a" />
          </mesh>
        </RigidBody>
      ))}
    </>
  );
}

function applySpawn(c: AIState, way: Float32Array, segIdx: number, t: number) {
  c.way = way;
  c.segIdx = segIdx;
  c.t = t;
  c.arc = arcLength(way, segIdx, t);
}

function endKey(x: number, z: number): string {
  return `${Math.round(x / ENDPOINT_GRID_M)},${Math.round(z / ENDPOINT_GRID_M)}`;
}

// At a way's terminal vertex, pick a connected way that leaves from the same
// endpoint. If a candidate joins at its END, return a reversed copy so the
// car always drives the new way segIdx 0 → N-1.
function pickConnectedWay(
  endpointMap: Map<string, Array<{ way: Float32Array; atStart: boolean }>>,
  current: Float32Array,
  lx: number,
  lz: number,
  reversedCache: WeakMap<Float32Array, Float32Array>,
): Float32Array | null {
  const list = endpointMap.get(endKey(lx, lz));
  if (!list || list.length === 0) return null;
  // Filter out the way we just finished so we don't ping-pong.
  const candidates = list.filter((c) => c.way !== current);
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  if (pick.atStart) return pick.way;
  // Joins at its END — reverse so we still iterate forward.
  let rev = reversedCache.get(pick.way);
  if (!rev) {
    rev = reverseWay(pick.way);
    reversedCache.set(pick.way, rev);
  }
  return rev;
}

function reverseWay(w: Float32Array): Float32Array {
  const N = w.length / 2;
  const out = new Float32Array(w.length);
  for (let i = 0; i < N; i++) {
    out[i * 2] = w[(N - 1 - i) * 2];
    out[i * 2 + 1] = w[(N - 1 - i) * 2 + 1];
  }
  return out;
}

function wayLength(w: Float32Array): number {
  let total = 0;
  for (let i = 0; i < w.length / 2 - 1; i++) {
    const dx = w[(i + 1) * 2] - w[i * 2];
    const dz = w[(i + 1) * 2 + 1] - w[i * 2 + 1];
    total += Math.hypot(dx, dz);
  }
  return total;
}

function arcLength(w: Float32Array, segIdx: number, t: number): number {
  let total = 0;
  for (let i = 0; i < segIdx; i++) {
    const dx = w[(i + 1) * 2] - w[i * 2];
    const dz = w[(i + 1) * 2 + 1] - w[i * 2 + 1];
    total += Math.hypot(dx, dz);
  }
  const dx = w[(segIdx + 1) * 2] - w[segIdx * 2];
  const dz = w[(segIdx + 1) * 2 + 1] - w[segIdx * 2 + 1];
  total += Math.hypot(dx, dz) * t;
  return total;
}

function findSpawnSlot(
  ways: Float32Array[],
  lens: number[],
  cars: AIState[],
  self: AIState,
  px: number,
  pz: number,
  radius: number,
): { way: Float32Array; segIdx: number; t: number } | null {
  const r2 = radius * radius;
  const n = ways.length;
  const start = Math.floor(Math.random() * n);
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const w = ways[idx];
    if (w.length < 4) continue;
    let inRange = false;
    for (let j = 0; j < w.length / 2; j++) {
      const dx = w[j * 2] - px, dz = w[j * 2 + 1] - pz;
      if (dx * dx + dz * dz <= r2) { inRange = true; break; }
    }
    if (!inRange) continue;

    const totalLen = lens[idx];
    if (totalLen < MIN_GAP_M * 2) continue;

    for (let attempt = 0; attempt < 4; attempt++) {
      const targetArc = Math.random() * (totalLen - REPLAN_PADDING * 2) + REPLAN_PADDING;
      let ok = true;
      for (const o of cars) {
        if (o === self || o.way !== w) continue;
        if (Math.abs(o.arc - targetArc) < MIN_GAP_M) { ok = false; break; }
      }
      if (!ok) continue;
      const sp = arcToSegment(w, targetArc);
      return { way: w, segIdx: sp.segIdx, t: sp.t };
    }
  }
  return null;
}

function arcToSegment(w: Float32Array, target: number): { segIdx: number; t: number } {
  let acc = 0;
  const N = w.length / 2;
  for (let i = 0; i < N - 1; i++) {
    const dx = w[(i + 1) * 2] - w[i * 2];
    const dz = w[(i + 1) * 2 + 1] - w[i * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    if (acc + len >= target) {
      return { segIdx: i, t: (target - acc) / len };
    }
    acc += len;
  }
  return { segIdx: N - 2, t: 0.5 };
}
