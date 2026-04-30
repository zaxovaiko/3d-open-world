import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { BuiltEntry } from "./world-meshes";

// Roadside guard-rail blocks. Single InstancedMesh covers all barriers
// across all loaded tiles. Geometry: 0.6 m wide × 0.7 m tall × 1.6 m long
// concrete-coloured Lambert box. Bumped to halfHeight=0.7 so the player car
// can clip without flying over.

const BARRIER_W = 0.6;
const BARRIER_H = 0.7;
const BARRIER_L = 1.6;

const _yAxis = new THREE.Vector3(0, 1, 0);

type Props = { built: BuiltEntry[] };

export function Barriers({ built }: Props) {
  const totalCount = useMemo(() => {
    let n = 0;
    for (const e of built) n += e.data.barrierInstances.length / 3;
    return n;
  }, [built]);

  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.BoxGeometry(BARRIER_W, BARRIER_H, BARRIER_L), []);
  const material = useMemo(
    () => new THREE.MeshLambertMaterial({ color: "#cdc8be" }),
    [],
  );

  useEffect(() => {
    const m = ref.current;
    if (!m || totalCount === 0) return;
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    let i = 0;
    for (const e of built) {
      const arr = e.data.barrierInstances;
      for (let k = 0; k < arr.length; k += 3) {
        pos.set(arr[k], BARRIER_H / 2, arr[k + 1]);
        quat.setFromAxisAngle(_yAxis, arr[k + 2]);
        mat4.compose(pos, quat, scl);
        m.setMatrixAt(i++, mat4);
      }
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [built, totalCount]);

  if (totalCount === 0) return null;

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, totalCount]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}
