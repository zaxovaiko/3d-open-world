import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { SIGN_KINDS, signTexture, type SignKind } from "../world/road-signs";
import type { BuiltEntry } from "./world-meshes";

// Procedural European road signs:
// - Pole: shared cylinder geometry, single InstancedMesh across every sign
//   on the map.
// - Sign face: shared plane geometry, one InstancedMesh per kind, billboard
//   quad textured with a Vienna-Convention pictogram (canvas texture).
//
// Each OSM `traffic_sign` node becomes one pole + one sign instance. Yaw is
// hashed from position so the same node always faces the same direction.

const POLE_HEIGHT = 2.6;
const POLE_RADIUS = 0.04;
const SIGN_SIZE = 0.9;
const SIGN_Y = POLE_HEIGHT - SIGN_SIZE / 2;

const POLE_GEOM = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 8);
POLE_GEOM.translate(0, POLE_HEIGHT / 2, 0);
const POLE_MAT = new THREE.MeshLambertMaterial({ color: 0x8a8f96 });

const SIGN_GEOM = new THREE.PlaneGeometry(SIGN_SIZE, SIGN_SIZE);
SIGN_GEOM.translate(0, SIGN_Y, 0);

// One material per kind so the texture is bound once.
const SIGN_MATS: Record<SignKind, THREE.MeshBasicMaterial> = {} as Record<
  SignKind,
  THREE.MeshBasicMaterial
>;
for (const k of SIGN_KINDS) {
  SIGN_MATS[k] = new THREE.MeshBasicMaterial({
    map: signTexture(k),
    transparent: true,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
  });
}

type Props = { built: BuiltEntry[] };

export function RoadSigns({ built }: Props) {
  // Aggregate every kind's positions across loaded tiles.
  const byKind = useMemo(() => {
    const out = {} as Record<SignKind, Float32Array>;
    for (const k of SIGN_KINDS) {
      let total = 0;
      for (const e of built) total += e.data.signs[k].length;
      const pts = new Float32Array(total);
      let off = 0;
      for (const e of built) {
        const arr = e.data.signs[k];
        pts.set(arr, off);
        off += arr.length;
      }
      out[k] = pts;
    }
    return out;
  }, [built]);

  // All signs share one pole instanced mesh.
  const polePositions = useMemo(() => {
    let total = 0;
    for (const k of SIGN_KINDS) total += byKind[k].length;
    const pts = new Float32Array(total);
    let off = 0;
    for (const k of SIGN_KINDS) {
      pts.set(byKind[k], off);
      off += byKind[k].length;
    }
    return pts;
  }, [byKind]);

  return (
    <group>
      <PoleInstanced positions={polePositions} />
      {SIGN_KINDS.map((k) => (
        <SignInstanced key={k} kind={k} positions={byKind[k]} />
      ))}
    </group>
  );
}

const _yAxis = new THREE.Vector3(0, 1, 0);

function yawForPosition(x: number, z: number): number {
  const r = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (r - Math.floor(r)) * Math.PI * 2;
}

function PoleInstanced({ positions }: { positions: Float32Array }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = positions.length / 2;
  const capRef = useRef(0);
  const cap = useMemo(() => {
    const next = Math.max(capRef.current, count);
    capRef.current = next;
    return next;
  }, [count]);

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      pos.set(positions[i * 2], 0, positions[i * 2 + 1]);
      quat.identity();
      mat4.compose(pos, quat, scl);
      m.setMatrixAt(i, mat4);
    }
    m.count = count;
    m.instanceMatrix.needsUpdate = true;
  }, [positions, count]);

  if (cap === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[POLE_GEOM, POLE_MAT, cap]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}

function SignInstanced({ kind, positions }: { kind: SignKind; positions: Float32Array }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = positions.length / 2;
  const capRef = useRef(0);
  const cap = useMemo(() => {
    const next = Math.max(capRef.current, count);
    capRef.current = next;
    return next;
  }, [count]);

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 2];
      const z = positions[i * 2 + 1];
      // Offset sign forward along its facing direction so it sits on the
      // side of the pole, not centered through it.
      const yaw = yawForPosition(x, z);
      const ox = Math.sin(yaw) * (POLE_RADIUS + 0.01);
      const oz = Math.cos(yaw) * (POLE_RADIUS + 0.01);
      pos.set(x + ox, 0, z + oz);
      quat.setFromAxisAngle(_yAxis, yaw);
      mat4.compose(pos, quat, scl);
      m.setMatrixAt(i, mat4);
    }
    m.count = count;
    m.instanceMatrix.needsUpdate = true;
  }, [positions, count]);

  if (cap === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[SIGN_GEOM, SIGN_MATS[kind], cap]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}
