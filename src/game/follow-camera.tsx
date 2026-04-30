import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

type Props = {
  targetRef: React.RefObject<{ pos: THREE.Vector3; quat: THREE.Quaternion } | null>;
};

const OFFSET = new THREE.Vector3(0, 4, -10); // behind & above (chassis forward = +Z, so behind = -Z)
const LOOK_AHEAD = new THREE.Vector3(0, 1, 5);

export function FollowCamera({ targetRef }: Props) {
  const { camera } = useThree();
  const desiredPos = useRef(new THREE.Vector3());
  const lookAt = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    const t = targetRef.current;
    if (!t) return;
    desiredPos.current.copy(OFFSET).applyQuaternion(t.quat).add(t.pos);
    lookAt.current.copy(LOOK_AHEAD).applyQuaternion(t.quat).add(t.pos);

    const k = 1 - Math.exp(-dt * 6);
    camera.position.lerp(desiredPos.current, k);
    camera.lookAt(lookAt.current);
  });

  return null;
}
