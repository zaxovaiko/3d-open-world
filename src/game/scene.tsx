import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import { Suspense, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { LatLon } from "../types";
import { makeProjector } from "../world/project";
import { useTileStreamer } from "../world/tile-streamer";
import type { Built } from "../world/tile-build-client";
import { Tile, Ground } from "./tile";
import { WorldMeshes, WaterAnimator, type BuiltEntry } from "./world-meshes";
import { Prewarm } from "./prewarm";
import { Car } from "./car";
import { FollowCamera } from "./follow-camera";
import { AICars } from "./ai-cars";
import { AITrams } from "./ai-trams";
import { Grass } from "./grass";
import { POIs } from "./pois";
import { BuildingFleet } from "./buildings-fleet";
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
        camera={{ position: [0, 8, -15], fov: 60, near: 0.1, far: 700 }}
        dpr={[0.85, 1.25]}
        gl={{
          antialias: true,
          powerPreference: "high-performance",
          stencil: false,
          depth: true,
        }}
        onCreated={({ scene, gl }) => {
          scene.background = new THREE.Color("#cfd9e0");
          gl.setClearColor("#cfd9e0");
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
      >
        <AdaptiveDpr pixelated />
        <AdaptiveEvents />
        <hemisphereLight args={["#cbd9e8", "#3a4a3a", 0.9]} />
        <directionalLight position={[100, 200, 100]} intensity={1.0} />
        <fog attach="fog" args={["#cfd9e0", 100, 600]} />

        <Suspense fallback={null}>
          <Prewarm />
          <Physics gravity={[0, -9.81, 0]} timeStep={1 / 60} interpolate paused={paused}>
            <Ground playerPosRef={poseRef} />
            <WaterAnimator />
            <World
              proj={proj}
              carPos={carPos}
              forward={forward}
              poseRef={poseRef}
            />
            <Car spawn={[0, 1.2, 0]} onPose={onPose} />
            <FollowCamera targetRef={poseRef} />
            <CameraDirectionWatcher onChange={onForward} />
          </Physics>
        </Suspense>
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
  poseRef,
}: {
  proj: ReturnType<typeof makeProjector>;
  carPos: { x: number; z: number };
  forward: { x: number; z: number };
  poseRef: React.RefObject<{ pos: THREE.Vector3; quat: THREE.Quaternion } | null>;
}) {
  const tiles = useTileStreamer(proj, carPos, forward);
  const [builtMap, setBuiltMap] = useState<Map<string, Built>>(new Map());

  const onBuilt = useCallback((key: string, b: Built) => {
    setBuiltMap((prev) => {
      const next = new Map(prev);
      next.set(key, b);
      return next;
    });
  }, []);

  const onUnmount = useCallback((key: string) => {
    setBuiltMap((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Only feed WorldMeshes the entries whose tiles are still in the active set.
  const builtList = useMemo<BuiltEntry[]>(() => {
    const active = new Set(tiles.map((t) => t.key));
    const out: BuiltEntry[] = [];
    for (const [k, data] of builtMap) {
      if (active.has(k)) out.push({ key: k, data });
    }
    return out;
  }, [tiles, builtMap]);

  return (
    <>
      {tiles.map((t) => (
        <Tile key={t.key} tile={t} proj={proj} onBuilt={onBuilt} onUnmount={onUnmount} />
      ))}
      <WorldMeshes built={builtList} />
      <BuildingFleet built={builtList} />
      <POIs built={builtList} />
      <AICars built={builtList} playerPosRef={poseRef} />
      <AITrams built={builtList} playerPosRef={poseRef} />
      <Grass built={builtList} playerPosRef={poseRef} />
    </>
  );
}
