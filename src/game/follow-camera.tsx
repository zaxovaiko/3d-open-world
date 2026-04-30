import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

type Props = {
  targetRef: React.RefObject<{ pos: THREE.Vector3; quat: THREE.Quaternion } | null>;
};

// Camera offset in *yaw-only* space — chassis suspension pitch/roll never
// reaches the camera, so the view doesn't shake when the wheels hit a seam.
const OFFSET = new THREE.Vector3(0, 4, -10);
const LOOK_AHEAD = new THREE.Vector3(0, 1, 5);

const _yAxis = new THREE.Vector3(0, 1, 0);

export function FollowCamera({ targetRef }: Props) {
  const { camera } = useThree();
  const desiredPos = useRef(new THREE.Vector3());
  const lookAt = useRef(new THREE.Vector3());
  const smoothLook = useRef(new THREE.Vector3());
  const yawQuat = useRef(new THREE.Quaternion());
  const smoothYawQuat = useRef(new THREE.Quaternion());
  const initialised = useRef(false);

  useFrame((_, dt) => {
    const t = targetRef.current;
    if (!t) return;

    // Extract yaw (rotation around Y) from the chassis quaternion. Pitch and
    // roll from suspension stay out of the camera frame.
    const q = t.quat;
    const yaw = Math.atan2(2 * (q.y * q.w + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    yawQuat.current.setFromAxisAngle(_yAxis, yaw);

    if (!initialised.current) {
      smoothYawQuat.current.copy(yawQuat.current);
      initialised.current = true;
    }
    // Slerp the smoothed yaw toward the chassis yaw — soaks up small
    // per-step jitter while still tracking real turns quickly.
    const ks = 1 - Math.exp(-dt * 8);
    smoothYawQuat.current.slerp(yawQuat.current, ks);

    desiredPos.current.copy(OFFSET).applyQuaternion(smoothYawQuat.current).add(t.pos);
    lookAt.current.copy(LOOK_AHEAD).applyQuaternion(smoothYawQuat.current).add(t.pos);

    const k = 1 - Math.exp(-dt * 6);
    camera.position.lerp(desiredPos.current, k);
    smoothLook.current.lerp(lookAt.current, k);
    camera.lookAt(smoothLook.current);
  });

  return null;
}
