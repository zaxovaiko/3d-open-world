import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import type { BuiltEntry } from "./world-meshes";

const COUNT = 12;
const SPEED = 9; // m/s ~32 km/h
const SPAWN_RADIUS = 320; // pick ways within this distance from player
const DESPAWN_RADIUS = 500; // recycle when farther than this
const HIDDEN_Y = -200; // park inactive cars far below ground
const MIN_GAP_M = 14; // minimum spacing along a way between AI cars
const SLOW_GAP_M = 26; // start slowing down to keep this gap
const REPLAN_PADDING = 8; // when seeking a free spawn slot, jitter t by this far

type AIState = {
  body: RapierRigidBody | null;
  way: Float32Array | null; // flat (x, z) pairs
  segIdx: number; // current segment, advancing
  t: number; // progress along current segment 0..1
  // Distance travelled along the entire way from way[0] to current position.
  // Used for cheap pairwise spacing on the same way.
  arc: number;
};

type Props = {
  built: BuiltEntry[];
  // Player position ref so spawn/despawn logic can query without re-rendering.
  playerPosRef: React.RefObject<{ pos: THREE.Vector3 } | null>;
};

export function AICars({ built, playerPosRef }: Props) {
  // Flatten centerlines from all built tiles into one pool. Precompute total
  // length per way so spacing math is O(1) per car per frame.
  const { ways, lens } = useMemo(() => {
    const out: Float32Array[] = [];
    for (const e of built) for (const w of e.data.carRoadCenterlines) out.push(w);
    const lengths = out.map(wayLength);
    return { ways: out, lens: lengths };
  }, [built]);
  const waysRef = useRef(ways);
  const lensRef = useRef(lens);
  useEffect(() => { waysRef.current = ways; lensRef.current = lens; }, [ways, lens]);

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

    // Refresh per-frame arc for pairwise spacing on the same way.
    // Done at the top so all cars below it see consistent values.
    for (const c of cars) {
      if (c.way) c.arc = arcLength(c.way, c.segIdx, c.t);
    }

    for (const c of cars) {
      if (!c.body) continue;

      // Despawn check + spawn-into-empty-slot path.
      const tr = c.body.translation();
      const distToPlayer = Math.hypot(tr.x - px, tr.z - pz);
      if (!c.way || distToPlayer > DESPAWN_RADIUS) {
        const slot = findSpawnSlot(ws, lensRef.current, cars, c, px, pz, SPAWN_RADIUS);
        if (!slot) {
          // No free slot near the player — park below ground so old position
          // doesn't linger in view.
          c.way = null;
          c.body.setNextKinematicTranslation({ x: tr.x, y: HIDDEN_Y, z: tr.z });
          continue;
        }
        c.way = slot.way;
        c.segIdx = slot.segIdx;
        c.t = slot.t;
        c.arc = arcLength(slot.way, slot.segIdx, slot.t);
        const w = slot.way;
        const ax = w[c.segIdx * 2], az = w[c.segIdx * 2 + 1];
        const bx = w[(c.segIdx + 1) * 2], bz = w[(c.segIdx + 1) * 2 + 1];
        const fx = ax + (bx - ax) * c.t;
        const fz = az + (bz - az) * c.t;
        c.body.setTranslation({ x: fx, y: 0.6, z: fz }, true);
        continue;
      }

      // Spacing: find the closest car ahead of this one on the same way and
      // throttle our speed if it would collide. Quadratic in COUNT but COUNT
      // is small.
      let aheadGap = Infinity;
      for (const o of cars) {
        if (o === c || o.way !== c.way) continue;
        const gap = o.arc - c.arc;
        if (gap > 0 && gap < aheadGap) aheadGap = gap;
      }
      let speed = SPEED;
      if (aheadGap < SLOW_GAP_M) {
        if (aheadGap <= MIN_GAP_M) {
          speed = 0;
        } else {
          speed = SPEED * (aheadGap - MIN_GAP_M) / (SLOW_GAP_M - MIN_GAP_M);
        }
      }

      // Advance along current segment.
      const w = c.way;
      const N = w.length / 2;
      if (c.segIdx >= N - 1) {
        c.way = null;
        continue;
      }
      const ax = w[c.segIdx * 2], az = w[c.segIdx * 2 + 1];
      const bx = w[(c.segIdx + 1) * 2], bz = w[(c.segIdx + 1) * 2 + 1];
      const segLen = Math.hypot(bx - ax, bz - az) || 1;
      c.t += (speed * dt) / segLen;
      while (c.t >= 1 && c.segIdx < N - 2) {
        c.t -= 1;
        c.segIdx++;
      }
      if (c.t >= 1) {
        // End of way — recycle next frame.
        c.way = null;
        continue;
      }

      // Target along segment + heading.
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
          position={[0, HIDDEN_Y, 0]} // hidden until first spawn
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

const COLORS = ["#1f6feb", "#2da44e", "#bf8700", "#cf222e", "#8250df", "#0a3069", "#9a6700", "#444c56"];

// Total polyline length.
function wayLength(w: Float32Array): number {
  let total = 0;
  for (let i = 0; i < w.length / 2 - 1; i++) {
    const dx = w[(i + 1) * 2] - w[i * 2];
    const dz = w[(i + 1) * 2 + 1] - w[i * 2 + 1];
    total += Math.hypot(dx, dz);
  }
  return total;
}

// Distance from way[0] to (segIdx + t).
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

// Find a (way, segIdx, t) slot near the player such that no other AI car is
// within MIN_GAP_M of it on the same way. Returns null if nothing is free.
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
  // Try up to N ways, taking the first vertex within radius. For each, find a
  // random-ish arc position whose nearest neighbour is at least MIN_GAP_M away.
  for (let i = 0; i < n; i++) {
    const w = ways[(start + i) % n];
    if (w.length < 4) continue;
    // Allow any vertex within radius — not just the first.
    let inRange = false;
    for (let j = 0; j < w.length / 2; j++) {
      const dx = w[j * 2] - px, dz = w[j * 2 + 1] - pz;
      if (dx * dx + dz * dz <= r2) { inRange = true; break; }
    }
    if (!inRange) continue;

    const totalLen = lens[(start + i) % n];
    if (totalLen < MIN_GAP_M * 2) continue;

    // Try a few candidate arc offsets.
    for (let attempt = 0; attempt < 4; attempt++) {
      const targetArc = Math.random() * (totalLen - REPLAN_PADDING * 2) + REPLAN_PADDING;
      // Reject if any other car on the same way is too close.
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

// Convert a target arc length into (segIdx, t).
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
