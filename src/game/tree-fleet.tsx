import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { TreeInstance, TreeKind } from "../world/trees";

// Per-kind instanced sub-mesh (e.g. broadleaf trunk + canopy). Two-mesh
// trees (trunk+top) use two of these.
type Sub = {
  geom: THREE.BufferGeometry;
  mat: THREE.Material;
  yOffset: number; // multiplied by scale
};

const TRUNK_BROADLEAF: Sub = {
  geom: new THREE.CylinderGeometry(0.25, 0.35, 3, 5),
  mat: new THREE.MeshLambertMaterial({ color: "#5b3a1d" }),
  yOffset: 1.5,
};
const CANOPY_BROADLEAF: Sub = {
  geom: new THREE.SphereGeometry(2, 6, 4),
  mat: new THREE.MeshLambertMaterial({ color: "#3f7a3a" }),
  yOffset: 4.5,
};
const TRUNK_CONIFER: Sub = {
  geom: new THREE.CylinderGeometry(0.18, 0.28, 4, 5),
  mat: new THREE.MeshLambertMaterial({ color: "#3a2614" }),
  yOffset: 2,
};
const CANOPY_CONIFER: Sub = {
  geom: new THREE.ConeGeometry(1.8, 6, 7),
  mat: new THREE.MeshLambertMaterial({ color: "#1f5a32" }),
  yOffset: 6,
};
const TRUNK_PALM: Sub = {
  geom: new THREE.CylinderGeometry(0.18, 0.22, 6, 6),
  mat: new THREE.MeshLambertMaterial({ color: "#7a5a36" }),
  yOffset: 3,
};
const CANOPY_PALM: Sub = {
  geom: new THREE.ConeGeometry(2.2, 0.9, 8),
  mat: new THREE.MeshLambertMaterial({ color: "#4a8a3c" }),
  yOffset: 6.4,
};
const BUSH: Sub = {
  geom: new THREE.SphereGeometry(1.2, 6, 4),
  mat: new THREE.MeshLambertMaterial({ color: "#4f8a3c" }),
  yOffset: 1.0,
};

const SUBS: Record<TreeKind, Sub[]> = {
  broadleaf: [TRUNK_BROADLEAF, CANOPY_BROADLEAF],
  conifer: [TRUNK_CONIFER, CANOPY_CONIFER],
  palm: [TRUNK_PALM, CANOPY_PALM],
  bush: [BUSH],
};

type Props = { buckets: Record<TreeKind, TreeInstance[]> };

const KINDS: TreeKind[] = ["broadleaf", "conifer", "palm", "bush"];

// Single InstancedMesh per (kind, sub-mesh). Matrix buffer updated in-place
// when buckets change — no React unmount/remount, no GPU buffer reallocation
// unless capacity grows.
export function TreeFleet({ buckets }: Props) {
  return (
    <group>
      {KINDS.flatMap((k) =>
        SUBS[k].map((sub, si) => (
          <TreeKindMesh key={`${k}_${si}`} kind={k} sub={sub} instances={buckets[k]} />
        )),
      )}
    </group>
  );
}

function TreeKindMesh({
  sub,
  instances,
}: {
  kind: TreeKind;
  sub: Sub;
  instances: TreeInstance[];
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  // Capacity grows but never shrinks within a session — avoids reallocating
  // the matrix buffer when tile arrivals temporarily increase tree count.
  const capRef = useRef(0);
  const cap = useMemo(() => {
    const next = Math.max(capRef.current, instances.length);
    capRef.current = next;
    return next;
  }, [instances.length]);

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (let i = 0; i < instances.length; i++) {
      const t = instances[i];
      pos.set(t.x, sub.yOffset * t.scale, t.z);
      scl.setScalar(t.scale);
      mat4.compose(pos, quat, scl);
      m.setMatrixAt(i, mat4);
    }
    m.count = instances.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.boundingSphere == null) m.computeBoundingSphere();
  }, [instances, sub.yOffset]);

  if (cap === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[sub.geom, sub.mat, cap]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}
