import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { useGLTF } from "@react-three/drei";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import * as THREE from "three";
import type { BuiltEntry } from "./world-meshes";

const COUNT = 5;
const SPEED = 11; // m/s, ~40 km/h
const SPAWN_RADIUS = 600;
const DESPAWN_RADIUS = 1200;
const HIDDEN_Y = -200;
const MIN_GAP_M = 60; // trams are long, keep them apart
const SLOW_GAP_M = 100;
const REPLAN_PADDING = 30;
const ENDPOINT_GRID_M = 2;

const TRAM_GLB = "/ai-cars/tram.glb";
const TARGET_LENGTH_M = 18;

useGLTF.preload(TRAM_GLB);

type AIState = {
  body: RapierRigidBody | null;
  way: Float32Array | null;
  prefix: Float32Array | null;
  segIdx: number;
  t: number;
  arc: number;
};

type Props = {
  built: BuiltEntry[];
  playerPosRef: React.RefObject<{ pos: THREE.Vector3 } | null>;
};

export function AITrams({ built, playerPosRef }: Props) {
  const { ways, lens, prefixByWay, endpointMap } = useMemo(() => {
    const out: Float32Array[] = [];
    for (const e of built) for (const w of e.data.tramCenterlines) out.push(w);
    const prefByWay = new Map<Float32Array, Float32Array>();
    const lengths = new Array<number>(out.length);
    for (let i = 0; i < out.length; i++) {
      const pre = prefixLengths(out[i]);
      prefByWay.set(out[i], pre);
      lengths[i] = pre[pre.length - 1] ?? 0;
    }

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
    return { ways: out, lens: lengths, prefixByWay: prefByWay, endpointMap: map };
  }, [built]);

  const waysRef = useRef(ways);
  const lensRef = useRef(lens);
  const prefixByWayRef = useRef(prefixByWay);
  const endpointMapRef = useRef(endpointMap);
  const reversedCacheRef = useRef(new WeakMap<Float32Array, Float32Array>());

  useEffect(() => {
    waysRef.current = ways;
    lensRef.current = lens;
    prefixByWayRef.current = prefixByWay;
    endpointMapRef.current = endpointMap;
  }, [ways, lens, prefixByWay, endpointMap]);

  const tramsRef = useRef<AIState[]>(
    Array.from({ length: COUNT }, () => ({ body: null, way: null, prefix: null, segIdx: 0, t: 0, arc: 0 })),
  );

  const byWayRef = useRef(new Map<Float32Array, AIState[]>());

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, dt) => {
    const trams = tramsRef.current;
    const ws = waysRef.current;
    if (ws.length === 0) return;
    const player = playerPosRef.current?.pos;
    const px = player?.x ?? 0, pz = player?.z ?? 0;

    const byWay = byWayRef.current;
    byWay.clear();
    for (const c of trams) {
      if (!c.way || !c.prefix) continue;
      const dx = c.way[(c.segIdx + 1) * 2] - c.way[c.segIdx * 2];
      const dz = c.way[(c.segIdx + 1) * 2 + 1] - c.way[c.segIdx * 2 + 1];
      c.arc = c.prefix[c.segIdx] + Math.sqrt(dx * dx + dz * dz) * c.t;
      let list = byWay.get(c.way);
      if (!list) { list = []; byWay.set(c.way, list); }
      list.push(c);
    }

    for (const c of trams) {
      if (!c.body) continue;
      const tr = c.body.translation();
      const ddx = tr.x - px, ddz = tr.z - pz;
      const distToPlayer = Math.sqrt(ddx * ddx + ddz * ddz);

      if (!c.way || distToPlayer > DESPAWN_RADIUS) {
        const slot = findSpawnSlot(ws, lensRef.current, trams, c, px, pz, SPAWN_RADIUS);
        if (!slot) {
          c.way = null;
          c.prefix = null;
          c.body.setNextKinematicTranslation({ x: tr.x, y: HIDDEN_Y, z: tr.z });
          continue;
        }
        applySpawn(c, slot.way, prefixByWayRef.current.get(slot.way) ?? null, slot.segIdx, slot.t);
        const w = slot.way;
        const ax = w[c.segIdx * 2], az = w[c.segIdx * 2 + 1];
        const bx = w[(c.segIdx + 1) * 2], bz = w[(c.segIdx + 1) * 2 + 1];
        const fx = ax + (bx - ax) * c.t;
        const fz = az + (bz - az) * c.t;
        c.body.setTranslation({ x: fx, y: 0.6, z: fz }, true);
        continue;
      }

      let aheadGap = Infinity;
      const sameWay = byWay.get(c.way);
      if (sameWay) {
        for (const o of sameWay) {
          if (o === c) continue;
          const gap = o.arc - c.arc;
          if (gap > 0 && gap < aheadGap) aheadGap = gap;
        }
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
      const sdx = bx - ax, sdz = bz - az;
      const segLen = Math.sqrt(sdx * sdx + sdz * sdz) || 1;
      c.t += (speed * dt) / segLen;
      while (c.t >= 1 && c.segIdx < N - 2) {
        c.t -= 1;
        c.segIdx++;
      }

      if (c.t >= 1 && c.segIdx >= N - 2) {
        const lx = w[(N - 1) * 2], lz = w[(N - 1) * 2 + 1];
        const next = pickConnectedWay(endpointMapRef.current, w, lx, lz, reversedCacheRef.current);
        if (next) {
          let nextPrefix = prefixByWayRef.current.get(next);
          if (!nextPrefix) {
            nextPrefix = prefixLengths(next);
            prefixByWayRef.current.set(next, nextPrefix);
          }
          applySpawn(c, next, nextPrefix, 0, 0);
          continue;
        }
        c.way = null;
        c.prefix = null;
        continue;
      }

      const ux = w[c.segIdx * 2], uz = w[c.segIdx * 2 + 1];
      const vx = w[(c.segIdx + 1) * 2], vz = w[(c.segIdx + 1) * 2 + 1];
      const tx = ux + (vx - ux) * c.t;
      const tz = uz + (vz - uz) * c.t;
      const dx = vx - ux, dz = vz - uz;
      const yaw = Math.atan2(dx, dz);

      c.body.setNextKinematicTranslation({ x: tx, y: 0.5, z: tz });
      tmpQ.setFromAxisAngle(tmpAxis, yaw);
      c.body.setNextKinematicRotation({ x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w });
    }
  });

  return (
    <>
      {tramsRef.current.map((c, i) => (
        <TramBody
          key={i}
          attachBody={(b) => { c.body = b; }}
        />
      ))}
    </>
  );
}

function TramBody({
  attachBody,
}: {
  attachBody: (b: RapierRigidBody | null) => void;
}) {
  const gltf = useGLTF(TRAM_GLB);
  const sceneClone = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);

  const { scale, yShift, yawFix } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const lengthAxis = size.x > size.z ? "x" : "z";
    const lengthVal = lengthAxis === "x" ? size.x : size.z;
    const s = TARGET_LENGTH_M / Math.max(lengthVal, 0.01);
    const yaw = lengthAxis === "x" ? Math.PI / 2 : 0;
    const yShiftVal = -box.min.y * s;
    return { scale: s, yShift: yShiftVal, yawFix: yaw };
  }, [gltf.scene]);

  return (
    <RigidBody
      ref={attachBody}
      type="kinematicPosition"
      colliders={false}
      position={[0, HIDDEN_Y, 0]}
      ccd
    >
      <CuboidCollider args={[1.3, 1.3, TARGET_LENGTH_M / 2]} restitution={0.05} friction={0.5} />
      <group rotation={[0, yawFix, 0]} scale={scale} position={[0, yShift - 0.5, 0]}>
        <primitive object={sceneClone} />
      </group>
    </RigidBody>
  );
}

function applySpawn(c: AIState, way: Float32Array, prefix: Float32Array | null, segIdx: number, t: number) {
  c.way = way;
  c.prefix = prefix;
  c.segIdx = segIdx;
  c.t = t;
  if (prefix) {
    const dx = way[(segIdx + 1) * 2] - way[segIdx * 2];
    const dz = way[(segIdx + 1) * 2 + 1] - way[segIdx * 2 + 1];
    c.arc = prefix[segIdx] + Math.sqrt(dx * dx + dz * dz) * t;
  } else {
    c.arc = 0;
  }
}

function endKey(x: number, z: number): string {
  return `${Math.round(x / ENDPOINT_GRID_M)},${Math.round(z / ENDPOINT_GRID_M)}`;
}

function pickConnectedWay(
  endpointMap: Map<string, Array<{ way: Float32Array; atStart: boolean }>>,
  current: Float32Array,
  lx: number,
  lz: number,
  reversedCache: WeakMap<Float32Array, Float32Array>,
): Float32Array | null {
  const list = endpointMap.get(endKey(lx, lz));
  if (!list || list.length === 0) return null;
  const candidates = list.filter((c) => c.way !== current);
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  if (pick.atStart) return pick.way;
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

function prefixLengths(w: Float32Array): Float32Array {
  const N = w.length / 2;
  const pre = new Float32Array(N);
  for (let i = 1; i < N; i++) {
    const dx = w[i * 2] - w[(i - 1) * 2];
    const dz = w[i * 2 + 1] - w[(i - 1) * 2 + 1];
    pre[i] = pre[i - 1] + Math.sqrt(dx * dx + dz * dz);
  }
  return pre;
}

function findSpawnSlot(
  ways: Float32Array[],
  lens: number[],
  trams: AIState[],
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
      for (const o of trams) {
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
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    if (acc + len >= target) {
      return { segIdx: i, t: (target - acc) / len };
    }
    acc += len;
  }
  return { segIdx: N - 2, t: 0.5 };
}
