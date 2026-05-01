import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import * as THREE from "three";
import type { PoiKind } from "../world/tile-worker";
import type { BuiltEntry } from "./world-meshes";

// One InstancedMesh per (kind, sub-mesh) drawing every map POI of that kind
// across the loaded tiles. Models are CC0 from poly.pizza, baked + scaled
// to a per-kind target height, materials swapped to MeshLambertMaterial.

const MODELS: Record<PoiKind, { url: string; targetHeight: number; randomYaw: boolean }> = {
  lamp:     { url: "/objects/lamp.glb",     targetHeight: 5.0, randomYaw: true },
  bench:    { url: "/objects/bench.glb",    targetHeight: 0.9, randomYaw: true },
  mailbox:  { url: "/objects/mailbox.glb",  targetHeight: 1.2, randomYaw: true },
  hydrant:  { url: "/objects/hydrant.glb",  targetHeight: 0.8, randomYaw: true },
  signpost: { url: "/objects/signpost.glb", targetHeight: 2.4, randomYaw: true },
};

for (const v of Object.values(MODELS)) useGLTF.preload(v.url);

const KINDS: PoiKind[] = ["lamp", "bench", "mailbox", "hydrant", "signpost"];

type Props = { built: BuiltEntry[] };

export function POIs({ built }: Props) {
  return (
    <group>
      {KINDS.map((k) => (
        <KindPOIs key={k} kind={k} built={built} />
      ))}
    </group>
  );
}

type SubMesh = { geometry: THREE.BufferGeometry; material: THREE.Material };

function KindPOIs({ kind, built }: { kind: PoiKind; built: BuiltEntry[] }) {
  const cfg = MODELS[kind];
  const gltf = useGLTF(cfg.url);

  // Bake mesh world transforms + Lambert material swap, then scale model
  // so its native height matches cfg.targetHeight.
  const { subs, baseScale, baseY } = useMemo(() => {
    const cloned = SkeletonUtils.clone(gltf.scene) as THREE.Group;
    cloned.updateMatrixWorld(true);
    const out: SubMesh[] = [];
    cloned.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      baked.computeBoundingSphere();
      const src = Array.isArray(m.material) ? m.material[0] : m.material;
      let mat: THREE.Material;
      if (src instanceof THREE.MeshStandardMaterial || src instanceof THREE.MeshPhysicalMaterial) {
        mat = new THREE.MeshLambertMaterial({
          map: src.map,
          color: src.color,
          transparent: src.transparent,
          opacity: src.opacity,
          alphaTest: src.alphaTest,
          side: src.side,
          vertexColors: src.vertexColors,
        });
      } else {
        mat = src as THREE.Material;
      }
      out.push({ geometry: baked, material: mat });
    });
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const s of out) {
      tmp.setFromBufferAttribute(s.geometry.getAttribute("position") as THREE.BufferAttribute);
      box.union(tmp);
    }
    const sz = new THREE.Vector3();
    box.getSize(sz);
    const h = sz.y || 1;
    return { subs: out, baseScale: cfg.targetHeight / h, baseY: -box.min.y };
  }, [gltf.scene, cfg]);

  // Aggregate instance positions across all loaded tiles for this kind.
  // Flat (x, z) pairs to avoid per-POI object allocation on every tile change.
  const positions = useMemo(() => {
    let total = 0;
    for (const e of built) total += e.data.pois[kind].length;
    const pts = new Float32Array(total);
    let off = 0;
    for (const e of built) {
      const arr = e.data.pois[kind];
      pts.set(arr, off);
      off += arr.length;
    }
    return pts;
  }, [built, kind]);

  if (positions.length === 0 || subs.length === 0) return null;
  return (
    <>
      {subs.map((sub, si) => (
        <SubInstanced
          key={si}
          sub={sub}
          positions={positions}
          baseScale={baseScale}
          baseY={baseY}
          randomYaw={cfg.randomYaw}
        />
      ))}
    </>
  );
}

const _yAxis = new THREE.Vector3(0, 1, 0);

function SubInstanced({
  sub,
  positions,
  baseScale,
  baseY,
  randomYaw,
}: {
  sub: SubMesh;
  positions: Float32Array;
  baseScale: number;
  baseY: number;
  randomYaw: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const capRef = useRef(0);
  const count = positions.length / 2;
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
    const scl = new THREE.Vector3(baseScale, baseScale, baseScale);
    const y = baseY * baseScale;
    for (let i = 0; i < count; i++) {
      const x = positions[i * 2];
      const z = positions[i * 2 + 1];
      pos.set(x, y, z);
      if (randomYaw) {
        const r = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
        const yaw = (r - Math.floor(r)) * Math.PI * 2;
        quat.setFromAxisAngle(_yAxis, yaw);
      } else {
        quat.identity();
      }
      mat4.compose(pos, quat, scl);
      m.setMatrixAt(i, mat4);
    }
    m.count = count;
    m.instanceMatrix.needsUpdate = true;
  }, [positions, count, baseScale, baseY, randomYaw]);

  if (cap === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[sub.geometry, sub.material, cap]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}
