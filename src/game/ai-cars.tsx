import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import type { BuiltEntry } from "./world-meshes";

const COUNT = 12;
const SPEED = 9; // m/s ~32 km/h
const SPAWN_RADIUS = 220; // pick ways within this distance from player
const DESPAWN_RADIUS = 380; // recycle when farther than this

const COLORS = ["#1f6feb", "#2da44e", "#bf8700", "#cf222e", "#8250df", "#0a3069", "#9a6700", "#444c56"];

type AIState = {
  body: RapierRigidBody | null;
  way: Float32Array | null; // flat (x, z) pairs
  segIdx: number; // current segment, advancing
  t: number; // progress along current segment 0..1
};

type Props = {
  built: BuiltEntry[];
  // Player position ref so spawn/despawn logic can query without re-rendering.
  playerPosRef: React.RefObject<{ pos: THREE.Vector3 } | null>;
};

export function AICars({ built, playerPosRef }: Props) {
  // Flatten centerlines from all built tiles into one pool. A new array
  // identity per tile-set change is fine because cars only reach into it
  // from useFrame and pick a fresh way when their current one ends.
  const ways = useMemo(() => {
    const out: Float32Array[] = [];
    for (const e of built) for (const w of e.data.carRoadCenterlines) out.push(w);
    return out;
  }, [built]);
  const waysRef = useRef(ways);
  useEffect(() => { waysRef.current = ways; }, [ways]);

  const carsRef = useRef<AIState[]>(
    Array.from({ length: COUNT }, () => ({ body: null, way: null, segIdx: 0, t: 0 })),
  );

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, dt) => {
    const cars = carsRef.current;
    const ws = waysRef.current;
    if (ws.length === 0) return;
    const player = playerPosRef.current?.pos;
    const px = player?.x ?? 0, pz = player?.z ?? 0;

    for (const c of cars) {
      if (!c.body) continue;

      // Despawn check + initial spawn.
      const t = c.body.translation();
      const distToPlayer = Math.hypot(t.x - px, t.z - pz);
      if (!c.way || distToPlayer > DESPAWN_RADIUS) {
        const w = pickWayNear(ws, px, pz, SPAWN_RADIUS);
        if (!w) continue;
        c.way = w;
        // Random start segment + position so cars don't all spawn at way[0].
        c.segIdx = Math.floor(Math.random() * Math.max(1, w.length / 2 - 1));
        c.t = Math.random();
        const ax = w[c.segIdx * 2], az = w[c.segIdx * 2 + 1];
        c.body.setTranslation({ x: ax, y: 0.6, z: az }, true);
        c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        continue;
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
      c.t += (SPEED * dt) / segLen;
      while (c.t >= 1 && c.segIdx < N - 2) {
        c.t -= 1;
        c.segIdx++;
      }
      if (c.t >= 1) {
        // End of way — pick a new nearby way next frame.
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

      // Kinematic-position move: AI cars push the player on contact (Rapier
      // resolves dynamic vs kinematic), and AI does not get knocked off path.
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
          position={[0, -50, 0]} // off-screen until first spawn
          ccd
        >
          <CuboidCollider args={[0.9, 0.6, 2]} restitution={0.05} friction={0.5} />
          <mesh castShadow={false}>
            <boxGeometry args={[1.8, 1.2, 4]} />
            <meshLambertMaterial color={COLORS[i % COLORS.length]} />
          </mesh>
          {/* Cabin/window strip for a hint of car shape. */}
          <mesh position={[0, 0.7, -0.4]}>
            <boxGeometry args={[1.6, 0.6, 1.8]} />
            <meshLambertMaterial color="#1a1a1a" />
          </mesh>
        </RigidBody>
      ))}
    </>
  );
}

// Pick a way whose first vertex is within `radius` of (px, pz). Random sample
// up to a few candidates so multiple cars don't pile onto the same street.
function pickWayNear(ways: Float32Array[], px: number, pz: number, radius: number): Float32Array | null {
  const r2 = radius * radius;
  // Reservoir-style: scan a random slice for cheap variety.
  const n = ways.length;
  const start = Math.floor(Math.random() * n);
  for (let i = 0; i < n; i++) {
    const w = ways[(start + i) % n];
    if (w.length < 4) continue;
    const dx = w[0] - px, dz = w[1] - pz;
    if (dx * dx + dz * dz <= r2) return w;
  }
  return null;
}
