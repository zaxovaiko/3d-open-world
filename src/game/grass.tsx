import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { BuiltEntry } from "./world-meshes";

// Ground-cover grass billboards. Small alpha-cutout quads on a 1m grid
// around the player. Single InstancedMesh, single draw call. Grid origin
// snaps to integer metres so blades don't shimmer when the player moves.
//
// Cells that fall inside a building footprint or close to a car-road
// centerline are skipped — no grass on roads or under walls.

const RADIUS_M = 60;
const BLADE_W = 0.35;
const BLADE_H = 0.45;
const ALPHA_TEST = 0.5;
const ROAD_HALF_W_M = 5; // any cell within 5m of a car-road centerline is masked

type Props = {
  playerPosRef: React.RefObject<{ pos: THREE.Vector3 } | null>;
  built: BuiltEntry[];
};

export function Grass({ playerPosRef, built }: Props) {
  const ref = useRef<THREE.InstancedMesh>(null);

  const D = RADIUS_M * 2;
  const cellCount = D * D;

  const jitter = useMemo(() => {
    const jx = new Float32Array(cellCount);
    const jz = new Float32Array(cellCount);
    const jr = new Float32Array(cellCount);
    const js = new Float32Array(cellCount);
    for (let i = 0; i < cellCount; i++) {
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b = Math.sin(i * 78.233) * 43758.5453;
      const c = Math.sin(i * 39.346) * 43758.5453;
      const d = Math.sin(i * 91.123) * 43758.5453;
      jx[i] = a - Math.floor(a);
      jz[i] = b - Math.floor(b);
      jr[i] = (c - Math.floor(c)) * Math.PI * 2;
      js[i] = 0.7 + (d - Math.floor(d)) * 0.6;
    }
    return { jx, jz, jr, js };
  }, [cellCount]);

  const material = useMemo(() => makeGrassMaterial(), []);
  const geometry = useMemo(() => new THREE.PlaneGeometry(BLADE_W, BLADE_H), []);

  // Hold built across renders without re-running matrix code on every render.
  const builtRef = useRef(built);
  useEffect(() => { builtRef.current = built; }, [built]);

  const lastOrigin = useRef({ x: NaN, z: NaN, builtVersion: -1 });
  // Bump when built changes so the next frame redraws even if origin stable.
  const builtVersionRef = useRef(0);
  useEffect(() => { builtVersionRef.current++; }, [built]);

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const p = playerPosRef.current?.pos;
    const px = p?.x ?? 0;
    const pz = p?.z ?? 0;
    const ox = Math.round(px);
    const oz = Math.round(pz);
    const bv = builtVersionRef.current;
    if (
      ox === lastOrigin.current.x &&
      oz === lastOrigin.current.z &&
      bv === lastOrigin.current.builtVersion
    ) return;
    lastOrigin.current.x = ox;
    lastOrigin.current.z = oz;
    lastOrigin.current.builtVersion = bv;

    // Build occupancy mask for the patch — Uint8Array, 1 byte per cell.
    const mask = new Uint8Array(cellCount);
    const minX = ox - RADIUS_M;
    const minZ = oz - RADIUS_M;
    const maxX = ox + RADIUS_M;
    const maxZ = oz + RADIUS_M;

    for (const e of builtRef.current) {
      // Mask building footprints via their per-building AABBs.
      for (const k of Object.keys(e.data.buildings) as Array<keyof typeof e.data.buildings>) {
        const bm = e.data.buildings[k];
        if (!bm) continue;
        for (const a of bm.aabbs) {
          const ax0 = a.cx - a.hx, ax1 = a.cx + a.hx;
          const az0 = a.cz - a.hz, az1 = a.cz + a.hz;
          if (ax1 < minX || ax0 > maxX || az1 < minZ || az0 > maxZ) continue;
          const cx0 = Math.max(0, Math.floor(ax0 - minX));
          const cx1 = Math.min(D - 1, Math.ceil(ax1 - minX));
          const cz0 = Math.max(0, Math.floor(az0 - minZ));
          const cz1 = Math.min(D - 1, Math.ceil(az1 - minZ));
          for (let cz = cz0; cz <= cz1; cz++) {
            const row = cz * D;
            for (let cx = cx0; cx <= cx1; cx++) mask[row + cx] = 1;
          }
        }
      }

      // Mask near each car-road segment within ROAD_HALF_W_M.
      for (const w of e.data.carRoadCenterlines) {
        const N = w.length / 2;
        for (let i = 0; i < N - 1; i++) {
          const a0 = w[i * 2], a1 = w[i * 2 + 1];
          const b0 = w[(i + 1) * 2], b1 = w[(i + 1) * 2 + 1];
          // Segment AABB ± road half-width.
          const sx0 = Math.min(a0, b0) - ROAD_HALF_W_M;
          const sx1 = Math.max(a0, b0) + ROAD_HALF_W_M;
          const sz0 = Math.min(a1, b1) - ROAD_HALF_W_M;
          const sz1 = Math.max(a1, b1) + ROAD_HALF_W_M;
          if (sx1 < minX || sx0 > maxX || sz1 < minZ || sz0 > maxZ) continue;
          const cx0 = Math.max(0, Math.floor(sx0 - minX));
          const cx1 = Math.min(D - 1, Math.ceil(sx1 - minX));
          const cz0 = Math.max(0, Math.floor(sz0 - minZ));
          const cz1 = Math.min(D - 1, Math.ceil(sz1 - minZ));
          const dx = b0 - a0, dz = b1 - a1;
          const segLen2 = dx * dx + dz * dz;
          const r2 = ROAD_HALF_W_M * ROAD_HALF_W_M;
          for (let cz = cz0; cz <= cz1; cz++) {
            const wz = cz + minZ + 0.5;
            for (let cx = cx0; cx <= cx1; cx++) {
              const idx = cz * D + cx;
              if (mask[idx]) continue;
              const wx = cx + minX + 0.5;
              // Closest point on segment.
              let t = ((wx - a0) * dx + (wz - a1) * dz) / (segLen2 || 1);
              if (t < 0) t = 0; else if (t > 1) t = 1;
              const px2 = a0 + dx * t, pz2 = a1 + dz * t;
              const ddx = wx - px2, ddz = wz - pz2;
              if (ddx * ddx + ddz * ddz <= r2) mask[idx] = 1;
            }
          }
        }
      }
    }

    // Write per-instance matrices, hiding masked cells via a y=-1000 shift.
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const hidden = new THREE.Vector3(0, -1000, 0);
    let i = 0;
    for (let dz = -RADIUS_M; dz < RADIUS_M; dz++) {
      for (let dx = -RADIUS_M; dx < RADIUS_M; dx++) {
        const idx = (dz + RADIUS_M) * D + (dx + RADIUS_M);
        if (mask[idx]) {
          mat4.compose(hidden, quat, _zeroScale);
        } else {
          const x = ox + dx + jitter.jx[idx];
          const z = oz + dz + jitter.jz[idx];
          pos.set(x, BLADE_H / 2, z);
          quat.setFromAxisAngle(yAxis, jitter.jr[idx]);
          const s = jitter.js[idx];
          scl.set(s, s, s);
          mat4.compose(pos, quat, scl);
        }
        m.setMatrixAt(i++, mat4);
      }
    }
    m.count = cellCount;
    m.instanceMatrix.needsUpdate = true;
  });

  useEffect(() => {
    lastOrigin.current.x = NaN;
    lastOrigin.current.z = NaN;
  }, []);

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, cellCount]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}

const _zeroScale = new THREE.Vector3(0.0001, 0.0001, 0.0001);

function makeGrassMaterial(): THREE.Material {
  const W = 64, H = 64;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  const blades = [
    { x: 0.5, lean: -0.15, color: "#4a8a3c" },
    { x: 0.4, lean: 0.05, color: "#3f7a3a" },
    { x: 0.6, lean: 0.18, color: "#5fa84d" },
    { x: 0.32, lean: -0.05, color: "#4f9a3a" },
    { x: 0.7, lean: -0.12, color: "#3a6e30" },
  ];
  for (const b of blades) {
    g.beginPath();
    const baseX = b.x * W;
    const tipX = (b.x + b.lean) * W;
    g.moveTo(baseX - 1.6, H);
    g.lineTo(baseX + 1.6, H);
    g.lineTo(tipX, 4);
    g.closePath();
    g.fillStyle = b.color;
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return new THREE.MeshLambertMaterial({
    map: tex,
    transparent: false,
    alphaTest: ALPHA_TEST,
    side: THREE.DoubleSide,
  });
}
