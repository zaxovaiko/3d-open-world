import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, useRapier, type RapierRigidBody } from "@react-three/rapier";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";

useGLTF.preload("/car.glb");

function CarModel() {
  const { scene } = useGLTF("/car.glb") as unknown as { scene: THREE.Group };
  const obj = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => {
      if (/wheel/i.test(o.name)) o.visible = false;
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.castShadow = false;
        m.receiveShadow = false;
        // Replace PBR (MeshStandardMaterial) with cheaper Lambert. Keeps the
        // baseColorMap / texture, drops metalness/roughness fragment math.
        const swap = (mat: THREE.Material): THREE.Material => {
          if (mat instanceof THREE.MeshStandardMaterial) {
            return new THREE.MeshLambertMaterial({
              map: mat.map,
              color: mat.color,
              transparent: mat.transparent,
              opacity: mat.opacity,
              alphaTest: mat.alphaTest,
              side: mat.side,
            });
          }
          return mat;
        };
        m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material as THREE.Material);
      }
    });
    return c;
  }, [scene]);
  // Ferrari model faces -Z by default. Math.PI around Y flips it to +Z so
  // the model's nose aligns with the chassis forward axis.
  return <primitive object={obj} rotation={[0, Math.PI, 0]} position={[0, -0.4, 0]} />;
}

type Props = {
  spawn?: [number, number, number];
  onPose?: (pos: THREE.Vector3, quat: THREE.Quaternion, speedKmh: number) => void;
};

const CHASSIS_W = 1.96;
const CHASSIS_H = 0.5;
const CHASSIS_L = 4.45;
const WHEEL_RADIUS = 0.34;
const SUSPENSION_REST = 0.18;

const ENGINE_FORCE = 5500;
const BRAKE_FORCE = 250;
const MAX_STEER = 0.5;
const MAX_SPEED_KMH = 160;

const wheelOffsets: Array<[number, number, number]> = [
  [-0.82, -0.1, 1.18], // FL
  [0.82, -0.1, 1.18], // FR
  [-0.82, -0.1, -1.32], // RL
  [0.82, -0.1, -1.32], // RR
];

type Keys = { forward: boolean; back: boolean; left: boolean; right: boolean; brake: boolean; reset: boolean };

function useKeys(): React.RefObject<Keys> {
  const keys = useRef<Keys>({
    forward: false,
    back: false,
    left: false,
    right: false,
    brake: false,
    reset: false,
  });
  useEffect(() => {
    const set = (v: boolean) => (e: KeyboardEvent) => {
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          keys.current.forward = v;
          break;
        case "KeyS":
        case "ArrowDown":
          keys.current.back = v;
          break;
        case "KeyA":
        case "ArrowLeft":
          keys.current.left = v;
          break;
        case "KeyD":
        case "ArrowRight":
          keys.current.right = v;
          break;
        case "Space":
          keys.current.brake = v;
          break;
        case "KeyR":
          keys.current.reset = v;
          break;
      }
    };
    const down = set(true);
    const up = set(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  return keys;
}

export function Car({ spawn = [0, 4, 0], onPose }: Props) {
  const bodyRef = useRef<RapierRigidBody>(null);
  const wheelMeshes = useRef<Array<THREE.Object3D | null>>([null, null, null, null]);
  const controllerRef = useRef<DynamicRayCastVehicleController | null>(null);
  const { world } = useRapier();
  const keys = useKeys();

  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const tmpInvQuat = useMemo(() => new THREE.Quaternion(), []);
  const tmpLocal = useMemo(() => new THREE.Vector3(), []);
  const engineRef = useRef(0);
  const steerRef = useRef(0);

  useEffect(() => {
    if (!bodyRef.current) return;
    const c = world.createVehicleController(bodyRef.current);
    c.indexUpAxis = 1;
    // Rapier defaults to Z forward (index 2). The previous code wrote
    // `c.setIndexForwardAxis = 2` which clobbered a setter method with a
    // number — kept silently and the default axis was used anyway. Leave
    // it implicit; the assignment is a no-op even when typed correctly.
    const suspensionDir = { x: 0, y: -1, z: 0 };
    const axle = { x: -1, y: 0, z: 0 };
    for (const [x, y, z] of wheelOffsets) {
      c.addWheel({ x, y, z }, suspensionDir, axle, SUSPENSION_REST, WHEEL_RADIUS);
    }
    for (let i = 0; i < 4; i++) {
      c.setWheelSuspensionStiffness(i, 70);
      c.setWheelMaxSuspensionTravel(i, 0.25);
      c.setWheelSuspensionCompression(i, 1.5);
      c.setWheelSuspensionRelaxation(i, 1.8);
      c.setWheelFrictionSlip(i, 2.5);
      c.setWheelSideFrictionStiffness(i, 1.4);
    }
    controllerRef.current = c;
    return () => {
      if (controllerRef.current) {
        world.removeVehicleController(controllerRef.current);
        controllerRef.current = null;
      }
    };
  }, [world]);

  useFrame((_, rawDt) => {
    const c = controllerRef.current;
    const body = bodyRef.current;
    if (!c || !body) return;

    // Lag spike (tile decode, GC, model load) → big dt → vehicle ray-cast jitter.
    // Skip our vehicle step but let rapier physics keep the body coasting on
    // its existing velocity (don't zero linvel — that feels like braking).
    if (rawDt > 0.1) return;
    const dt = Math.min(rawDt, 1 / 30);

    const k = keys.current;

    if (k.reset) {
      body.setTranslation({ x: spawn[0], y: spawn[1], z: spawn[2] }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      engineRef.current = 0;
      steerRef.current = 0;
    }

    // Speed limiter: cut forward throttle past MAX_SPEED_KMH so the car can't
    // keep accelerating; reverse and braking always allowed.
    const speedKmh = c.currentVehicleSpeed() * 3.6; // signed
    const limitForward = speedKmh >= MAX_SPEED_KMH;

    // Smooth acceleration: ramp engine force toward target (~0.6s to full throttle).
    const targetEngine =
      (k.forward && !limitForward ? ENGINE_FORCE : 0) + (k.back ? -ENGINE_FORCE * 0.6 : 0);
    const engineLerp = 1 - Math.exp(-dt * 4); // ~25% per 60ms
    engineRef.current += (targetEngine - engineRef.current) * engineLerp;
    c.setWheelEngineForce(2, engineRef.current);
    c.setWheelEngineForce(3, engineRef.current);

    const brake = k.brake ? BRAKE_FORCE : 0;
    for (let i = 0; i < 4; i++) c.setWheelBrake(i, brake);

    // Smooth steering ramp.
    const targetSteer = (k.left ? MAX_STEER : 0) + (k.right ? -MAX_STEER : 0);
    const steerLerp = 1 - Math.exp(-dt * 6);
    steerRef.current += (targetSteer - steerRef.current) * steerLerp;
    c.setWheelSteering(0, steerRef.current);
    c.setWheelSteering(1, steerRef.current);

    c.updateVehicle(dt);

    // Sync wheel meshes to controller's per-wheel transforms.
    for (let i = 0; i < 4; i++) {
      const m = wheelMeshes.current[i];
      if (!m) continue;
      const hp = c.wheelHardPoint(i);
      const sl = c.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      const steerAng = c.wheelSteering(i) ?? 0;
      const rot = c.wheelRotation(i) ?? 0;
      if (hp) {
        // hp is world space; convert to body local. Reuse buffers — no per-frame allocs.
        const t = body.translation();
        const q = body.rotation();
        tmpInvQuat.set(q.x, q.y, q.z, q.w).invert();
        tmpLocal.set(hp.x - t.x, hp.y - t.y, hp.z - t.z).applyQuaternion(tmpInvQuat);
        m.position.set(tmpLocal.x, tmpLocal.y - sl, tmpLocal.z);
        // Compose: cylinder lays along X (Z=π/2 base), then spin about wheel axle (X), then steer (Y).
        // Order "YXZ" applies Z first, then X, then Y: cylinder oriented → spin → steer.
        m.rotation.set(rot, steerAng, Math.PI / 2, "YXZ");
      }
    }

    // Report pose for camera/HUD.
    const t = body.translation();
    const q = body.rotation();
    tmpPos.set(t.x, t.y, t.z);
    tmpQuat.set(q.x, q.y, q.z, q.w);
    const speed = Math.abs(c.currentVehicleSpeed()) * 3.6;
    onPose?.(tmpPos, tmpQuat, speed);
  });

  return (
    <RigidBody
      ref={bodyRef}
      colliders={false}
      position={spawn}
      linearDamping={0.05}
      angularDamping={3}
      ccd
    >
      <CuboidCollider
        args={[CHASSIS_W / 2, CHASSIS_H / 2, CHASSIS_L / 2]}
        mass={1400}
        restitution={0}
        friction={0.8}
      />
      <CarModel />
      {wheelOffsets.map((p, i) => (
        <group
          key={i}
          ref={(el) => {
            wheelMeshes.current[i] = el;
          }}
          position={p}
          rotation={[0, 0, Math.PI / 2]}
        >
          {/* Tire */}
          <mesh>
            <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, 0.32, 18]} />
            <meshLambertMaterial color="#0a0a0a" />
          </mesh>
          {/* Rim outer cap */}
          <mesh position={[0, 0.17, 0]}>
            <cylinderGeometry args={[WHEEL_RADIUS * 0.65, WHEEL_RADIUS * 0.65, 0.02, 12]} />
            <meshLambertMaterial color="#c0c4c8" />
          </mesh>
          <mesh position={[0, -0.17, 0]}>
            <cylinderGeometry args={[WHEEL_RADIUS * 0.65, WHEEL_RADIUS * 0.65, 0.02, 12]} />
            <meshLambertMaterial color="#c0c4c8" />
          </mesh>
          {/* Hub center */}
          <mesh position={[0, 0.18, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.02, 8]} />
            <meshLambertMaterial color="#202020" />
          </mesh>
        </group>
      ))}
    </RigidBody>
  );
}
