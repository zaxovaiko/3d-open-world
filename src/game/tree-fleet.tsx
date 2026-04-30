import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { TreeInstance, TreeKind } from "../world/trees";

// Multiple GLB variants per kind so neighboring trees of the same kind don't
// look identical. Variant chosen per instance from a hash of (x, z).
const GLB: Record<TreeKind, string[]> = {
  broadleaf: ["/trees/broadleaf-1.glb", "/trees/broadleaf-2.glb", "/trees/broadleaf-3.glb"],
  conifer: ["/trees/conifer-1.glb", "/trees/conifer-2.glb", "/trees/conifer-3.glb"],
  palm: ["/trees/palm.glb"],
  bush: ["/trees/bush-1.glb", "/trees/bush-2.glb", "/trees/bush-3.glb"],
};

for (const k of Object.values(GLB)) for (const url of k) useGLTF.preload(url);

// Target real-world height the model should occupy at scale=1. Per-instance
// scale (0.85..1.25 from world/trees.ts) multiplies on top.
const TARGET_HEIGHT_M: Record<TreeKind, number> = {
  broadleaf: 7,
  conifer: 8,
  palm: 9,
  bush: 1.4,
};

// Leaf tints per kind. Quaternius "Twisted Tree" baseColor map ships in
// autumn colours; we drop the leaf texture and force a solid green so the
// fleet reads as "city greenery". Bark + bush base colour stay textured.
const LEAF_COLOR: Record<TreeKind, THREE.Color> = {
  broadleaf: new THREE.Color("#3f7a3a"),
  conifer: new THREE.Color("#1f5a32"),
  palm: new THREE.Color("#4a8a3c"),
  bush: new THREE.Color("#4f8a3c"),
};

const LEAF_NAME_RE = /leaf|leaves|canopy|foliage|crown|frond|palm/i;

type SubMesh = { geometry: THREE.BufferGeometry; material: THREE.Material };
type Variant = { subs: SubMesh[]; baseScale: number; baseY: number };

// Walk a loaded GLB scene, bake each mesh's world transform into its geometry,
// swap PBR materials for Lambert (cheaper fragment shader, same look from
// above), and force leaf materials to a solid green tint per kind.
function extractVariant(scene: THREE.Group, kind: TreeKind): Variant {
  scene.updateMatrixWorld(true);
  const subs: SubMesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const baked = m.geometry.clone();
    baked.applyMatrix4(m.matrixWorld);
    baked.computeBoundingSphere();

    const sourceMat = Array.isArray(m.material)
      ? (m.material[0] as THREE.Material)
      : (m.material as THREE.Material);
    const isLeaf = LEAF_NAME_RE.test(sourceMat.name) || LEAF_NAME_RE.test(m.name);

    let material: THREE.Material;
    if (isLeaf) {
      // Solid green — drop the autumn-coloured leaf texture entirely.
      material = new THREE.MeshLambertMaterial({ color: LEAF_COLOR[kind] });
    } else if (
      sourceMat instanceof THREE.MeshStandardMaterial ||
      sourceMat instanceof THREE.MeshPhysicalMaterial
    ) {
      material = new THREE.MeshLambertMaterial({
        map: sourceMat.map,
        color: sourceMat.color,
        transparent: sourceMat.transparent,
        opacity: sourceMat.opacity,
        alphaTest: sourceMat.alphaTest,
        side: sourceMat.side,
        vertexColors: sourceMat.vertexColors,
      });
    } else {
      material = sourceMat;
    }
    subs.push({ geometry: baked, material });
  });

  // Combined bbox so trunk + canopy scale together. baseY shifts the model up
  // so its lowest point sits on y=0 (model origin not always at trunk base).
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const s of subs) {
    tmp.setFromBufferAttribute(s.geometry.getAttribute("position") as THREE.BufferAttribute);
    box.union(tmp);
  }
  const sz = new THREE.Vector3();
  box.getSize(sz);
  const h = sz.y || 1;
  const baseScale = TARGET_HEIGHT_M[kind] / h;
  return { subs, baseScale, baseY: -box.min.y };
}

const KINDS: TreeKind[] = ["broadleaf", "conifer", "palm", "bush"];

type Props = { buckets: Record<TreeKind, TreeInstance[]> };

export function TreeFleet({ buckets }: Props) {
  return (
    <group>
      {KINDS.map((k) => (
        <KindTrees key={k} kind={k} instances={buckets[k]} />
      ))}
    </group>
  );
}

// Hash (x, z) → integer in [0, n). Deterministic per location so a given tree
// keeps the same variant when the tile reloads.
function variantIndex(x: number, z: number, n: number): number {
  if (n <= 1) return 0;
  const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453);
  return Math.floor((h - Math.floor(h)) * n);
}

function KindTrees({ kind, instances }: { kind: TreeKind; instances: TreeInstance[] }) {
  const urls = GLB[kind];
  // Load all variants for this kind. Hooks order is stable because GLB[kind]
  // is constant.
  const gltfs = urls.map((u) => useGLTF(u));
  const variants = useMemo(
    () => gltfs.map((g) => extractVariant(g.scene as THREE.Group, kind)),
    // gltfs is rebuilt every render; the scenes are cached refs so identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, ...gltfs.map((g) => g.scene)],
  );

  // Bucket instances by variant index so each variant gets its own
  // InstancedMesh per submesh.
  const byVariant = useMemo(() => {
    const out: TreeInstance[][] = variants.map(() => []);
    for (const t of instances) {
      const v = variantIndex(t.x, t.z, variants.length);
      out[v].push(t);
    }
    return out;
  }, [instances, variants]);

  if (instances.length === 0 || variants.length === 0) return null;
  return (
    <>
      {variants.map((v, vi) =>
        v.subs.map((sub, si) => (
          <SubInstanced
            key={`${vi}_${si}`}
            sub={sub}
            instances={byVariant[vi]}
            baseScale={v.baseScale}
            baseY={v.baseY}
          />
        )),
      )}
    </>
  );
}

const _yAxis = new THREE.Vector3(0, 1, 0);

function SubInstanced({
  sub,
  instances,
  baseScale,
  baseY,
}: {
  sub: SubMesh;
  instances: TreeInstance[];
  baseScale: number;
  baseY: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);

  // Capacity grows but never shrinks — avoids reallocating the matrix buffer
  // when streaming temporarily increases instance count.
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
      const s = t.scale * baseScale;
      // Random yaw so neighbouring same-variant trees don't read as clones.
      const r = (Math.sin(t.x * 12.9898 + t.z * 78.233) * 43758.5453);
      const yaw = (r - Math.floor(r)) * Math.PI * 2;
      quat.setFromAxisAngle(_yAxis, yaw);
      pos.set(t.x, baseY * s, t.z);
      scl.set(s, s, s);
      mat4.compose(pos, quat, scl);
      m.setMatrixAt(i, mat4);
    }
    m.count = instances.length;
    m.instanceMatrix.needsUpdate = true;
  }, [instances, baseScale, baseY]);

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
