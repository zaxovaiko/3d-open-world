import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { BUILDING_KINDS, type BuildingAABB, type BuildingKind } from "../world/buildings-shared";
import type { BuiltEntry } from "./world-meshes";

// CC0 building models from Kenney City Kit (Suburban + Commercial).
// Per-kind variants are picked deterministically per building from a hash of
// the building's centre, so a given footprint always renders the same model.
const GLB: Record<BuildingKind, string[]> = {
  house:      ["/buildings/house/1.glb", "/buildings/house/2.glb", "/buildings/house/3.glb", "/buildings/house/4.glb"],
  apartments: ["/buildings/apartments/1.glb", "/buildings/apartments/2.glb", "/buildings/apartments/3.glb"],
  office:     ["/buildings/office/1.glb", "/buildings/office/2.glb", "/buildings/office/3.glb"],
  retail:     ["/buildings/retail/1.glb", "/buildings/retail/2.glb", "/buildings/retail/3.glb"],
  industrial: ["/buildings/industrial/1.glb", "/buildings/industrial/2.glb"],
  warehouse:  ["/buildings/warehouse/1.glb", "/buildings/warehouse/2.glb"],
  school:     ["/buildings/school/1.glb", "/buildings/school/2.glb"],
  hospital:   ["/buildings/hospital/1.glb"],
  religious:  ["/buildings/religious/1.glb"],
  civic:      ["/buildings/civic/1.glb", "/buildings/civic/2.glb"],
  generic:    ["/buildings/generic/1.glb", "/buildings/generic/2.glb"],
};

for (const list of Object.values(GLB)) for (const url of list) useGLTF.preload(url);

type SubMesh = { geometry: THREE.BufferGeometry; material: THREE.Material };
type Variant = {
  subs: SubMesh[];
  // Native model dimensions (in model units, after world-transform bake).
  // Used to compute per-instance scale that fills the OSM footprint AABB.
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  minY: number;
  // True if the model's longest horizontal axis is X (rotation axis decision).
  longAxisX: boolean;
};

function extractVariant(scene: THREE.Group): Variant {
  scene.updateMatrixWorld(true);
  const subs: SubMesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const baked = m.geometry.clone();
    baked.applyMatrix4(m.matrixWorld);
    baked.computeBoundingSphere();

    const src = Array.isArray(m.material) ? (m.material[0] as THREE.Material) : (m.material as THREE.Material);
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
      mat = src;
    }
    subs.push({ geometry: baked, material: mat });
  });

  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const s of subs) {
    tmp.setFromBufferAttribute(s.geometry.getAttribute("position") as THREE.BufferAttribute);
    box.union(tmp);
  }
  const sz = new THREE.Vector3();
  box.getSize(sz);
  return {
    subs,
    sizeX: Math.max(sz.x, 0.01),
    sizeY: Math.max(sz.y, 0.01),
    sizeZ: Math.max(sz.z, 0.01),
    minY: box.min.y,
    longAxisX: sz.x >= sz.z,
  };
}

type Props = { built: BuiltEntry[] };

export function BuildingFleet({ built }: Props) {
  // Bucket every building AABB across loaded tiles by kind.
  const byKind = useMemo(() => {
    const out = {} as Record<BuildingKind, BuildingAABB[]>;
    for (const k of BUILDING_KINDS) out[k] = [];
    for (const e of built) {
      for (const k of BUILDING_KINDS) {
        const m = e.data.buildings[k];
        if (!m) continue;
        for (const a of m.aabbs) out[k].push(a);
      }
    }
    return out;
  }, [built]);

  return (
    <group>
      {BUILDING_KINDS.map((k) => (
        <KindBuildings key={k} kind={k} aabbs={byKind[k]} />
      ))}
    </group>
  );
}

function variantIndex(cx: number, cz: number, n: number): number {
  if (n <= 1) return 0;
  const h = Math.abs(Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453);
  return Math.floor((h - Math.floor(h)) * n);
}

function KindBuildings({ kind, aabbs }: { kind: BuildingKind; aabbs: BuildingAABB[] }) {
  const urls = GLB[kind];
  // Hooks order stable: GLB[kind] is constant.
  const gltfs = urls.map((u) => useGLTF(u));
  const variants = useMemo(
    () => gltfs.map((g) => extractVariant(g.scene as THREE.Group)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, ...gltfs.map((g) => g.scene)],
  );

  const byVariant = useMemo(() => {
    const out: BuildingAABB[][] = variants.map(() => []);
    for (const a of aabbs) {
      const v = variantIndex(a.cx, a.cz, variants.length);
      out[v].push(a);
    }
    return out;
  }, [aabbs, variants]);

  if (aabbs.length === 0 || variants.length === 0) return null;
  return (
    <>
      {variants.map((v, vi) =>
        v.subs.map((sub, si) => (
          <SubInstanced
            key={`${vi}_${si}`}
            sub={sub}
            variant={v}
            aabbs={byVariant[vi]}
          />
        )),
      )}
    </>
  );
}

const _yAxis = new THREE.Vector3(0, 1, 0);

function SubInstanced({
  sub,
  variant,
  aabbs,
}: {
  sub: SubMesh;
  variant: Variant;
  aabbs: BuildingAABB[];
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const capRef = useRef(0);
  const cap = useMemo(() => {
    const next = Math.max(capRef.current, aabbs.length);
    capRef.current = next;
    return next;
  }, [aabbs.length]);

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (let i = 0; i < aabbs.length; i++) {
      const a = aabbs[i];
      const targetX = a.hx * 2;
      const targetZ = a.hz * 2;
      const targetY = a.hy * 2;
      // Rotate 90° around Y when the model's long axis is opposite to the
      // footprint's long axis — keeps the model's long facade along the
      // street side instead of stretching the short axis.
      const targetLongX = targetX >= targetZ;
      const yaw = targetLongX === variant.longAxisX ? 0 : Math.PI / 2;
      const sx = (yaw === 0 ? targetX : targetZ) / variant.sizeX;
      const sz = (yaw === 0 ? targetZ : targetX) / variant.sizeZ;
      const sy = targetY / variant.sizeY;
      pos.set(a.cx, -variant.minY * sy, a.cz);
      quat.setFromAxisAngle(_yAxis, yaw);
      scl.set(sx, sy, sz);
      mat4.compose(pos, quat, scl);
      m.setMatrixAt(i, mat4);
    }
    m.count = aabbs.length;
    m.instanceMatrix.needsUpdate = true;
  }, [aabbs, variant]);

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
