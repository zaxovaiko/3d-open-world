import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { Sky, Stats } from "@react-three/drei";
import { Suspense, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { LatLon } from "../types";
import { makeProjector } from "../world/project";
import { useTileStreamer } from "../world/tile-streamer";
import { Tile, Ground } from "./tile";
import { Car } from "./car";
import { FollowCamera } from "./follow-camera";
import { Hud } from "../ui/hud";

type Props = { origin: LatLon };

const TILE_REPLAN_DIST = 100; // meters between car-pos state updates

export function Scene({ origin }: Props) {
  const proj = useMemo(() => makeProjector(origin), [origin]);
  const [carPos, setCarPos] = useState({ x: 0, z: 0 });
  const [forward, setForward] = useState({ x: 0, z: 1 });
  const [paused, setPaused] = useState(false);

  const poseRef = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion } | null>({
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
  });
  const speedDomRef = useRef<HTMLDivElement>(null);
  const lastReplanRef = useRef({ x: 0, z: 0 });
  const lastForwardRef = useRef({ x: 0, z: 1 });

  // Pause physics when tab hidden — avoids huge dt on resume.
  useEffect(() => {
    const handler = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  const onPose = useCallback(
    (pos: THREE.Vector3, quat: THREE.Quaternion, sp: number) => {
      if (poseRef.current) {
        poseRef.current.pos.copy(pos);
        poseRef.current.quat.copy(quat);
      }
      if (speedDomRef.current) {
        speedDomRef.current.textContent = `${Math.round(sp)} km/h`;
      }
      const last = lastReplanRef.current;
      if (
        Math.abs(pos.x - last.x) > TILE_REPLAN_DIST ||
        Math.abs(pos.z - last.z) > TILE_REPLAN_DIST
      ) {
        last.x = pos.x;
        last.z = pos.z;
        const x = pos.x, z = pos.z;
        startTransition(() => setCarPos({ x, z }));
      }
    },
    [],
  );

  const onForward = useCallback((fx: number, fz: number) => {
    const last = lastForwardRef.current;
    const dot = last.x * fx + last.z * fz;
    if (dot < 0.92) {
      last.x = fx;
      last.z = fz;
      startTransition(() => setForward({ x: fx, z: fz }));
    }
  }, []);

  return (
    <>
      <Canvas
        camera={{ position: [0, 8, -15], fov: 60, near: 0.1, far: 1500 }}
        dpr={1}
        gl={{ antialias: false, powerPreference: "high-performance", stencil: false, depth: true }}
      >
        <Sky sunPosition={[100, 50, 100]} />
        <hemisphereLight args={["#cbd9e8", "#3a4a3a", 0.9]} />
        <directionalLight position={[100, 200, 100]} intensity={1.0} />
        <fog attach="fog" args={["#cfd9e0", 200, 900]} />

        <Suspense fallback={null}>
          <Physics gravity={[0, -9.81, 0]} timeStep={1 / 60} interpolate paused={paused}>
            <Ground />
            <World proj={proj} carPos={carPos} forward={forward} />
            <Car spawn={[0, 1.2, 0]} onPose={onPose} />
            <FollowCamera targetRef={poseRef} />
            <CameraDirectionWatcher onChange={onForward} />
          </Physics>
        </Suspense>
        <Stats />
      </Canvas>
      <Hud ref={speedDomRef} />
    </>
  );
}

function CameraDirectionWatcher({ onChange }: { onChange: (fx: number, fz: number) => void }) {
  const { camera } = useThree();
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    camera.getWorldDirection(tmp);
    onChange(tmp.x, tmp.z);
  });
  return null;
}

function World({
  proj,
  carPos,
  forward,
}: {
  proj: ReturnType<typeof makeProjector>;
  carPos: { x: number; z: number };
  forward: { x: number; z: number };
}) {
  const tiles = useTileStreamer(proj, carPos, forward);
  const groupRefs = useRef<Map<string, THREE.Group>>(new Map());
  const refSetters = useRef<Map<string, (el: THREE.Group | null) => void>>(new Map());
  const frustum = useMemo(() => new THREE.Frustum(), []);
  const projScreen = useMemo(() => new THREE.Matrix4(), []);
  const sphere = useMemo(() => new THREE.Sphere(), []);

  function refFor(key: string) {
    let s = refSetters.current.get(key);
    if (!s) {
      s = (el) => {
        if (el) groupRefs.current.set(key, el);
        else groupRefs.current.delete(key);
      };
      refSetters.current.set(key, s);
    }
    return s;
  }

  useFrame(({ camera }) => {
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    for (const [, g] of groupRefs.current) {
      let anyVisible = false;
      for (const child of g.children) {
        const mesh = child as THREE.Mesh;
        const geom = mesh.geometry as THREE.BufferGeometry | undefined;
        if (geom?.boundingSphere) {
          sphere.copy(geom.boundingSphere).applyMatrix4(mesh.matrixWorld);
          mesh.visible = frustum.intersectsSphere(sphere);
        } else {
          mesh.visible = true;
        }
        if (mesh.visible) anyVisible = true;
      }
      g.visible = anyVisible;
    }
  });

  return (
    <>
      {tiles.map((t) => (
        <group key={t.key} ref={refFor(t.key)}>
          <Tile tile={t} proj={proj} />
        </group>
      ))}
    </>
  );
}
