import { useEffect, useMemo, useRef } from "react";
import { RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { TileData } from "../types";
import type { Projector } from "../world/project";
import { buildTileInWorker, type Built } from "../world/tile-build-client";
import { groundTexture } from "../world/textures";
import { buildTerrainGeometry } from "../world/terrain";

type Props = {
  tile: TileData;
  proj: Projector;
  onBuilt: (key: string, built: Built) => void;
  onUnmount: (key: string) => void;
};

// Headless tile: builds geometry in worker, hands result up to WorldMeshes.
// No rendering here — global merging happens in WorldMeshes.
export function Tile({ tile, proj, onBuilt, onUnmount }: Props) {
  useEffect(() => {
    const job = buildTileInWorker(tile, proj.origin);
    job.promise
      .then((b) => onBuilt(tile.key, b))
      .catch(() => {/* cancelled */});
    return () => {
      job.cancel();
      onUnmount(tile.key);
    };
  }, [tile, proj, onBuilt, onUnmount]);
  return null;
}

export const GROUND_SIZE = 4000;
const TERRAIN_SIZE = 4000;
const TERRAIN_SEGMENTS = 1; // flat — elevation removed
const FOLLOW_SNAP_M = 4; // re-centre when player has moved this far

type GroundProps = {
  playerPosRef: React.RefObject<{ pos: THREE.Vector3 } | null>;
};

// Ground follows the player. Visual mesh + physics body snap to a quantised
// world position so they always extend GROUND_SIZE / 2 in every direction
// from the car. Texture repeat is wide enough that the snap step never
// reveals a seam.
export function Ground({ playerPosRef }: GroundProps) {
  const TEX_REPEAT = 120;
  const tex = useMemo(() => {
    const t = groundTexture();
    t.repeat.set(TEX_REPEAT, TEX_REPEAT);
    return t;
  }, []);
  const terrainGeom = useMemo(() => buildTerrainGeometry(TERRAIN_SIZE, TERRAIN_SEGMENTS), []);

  const visualRef = useRef<THREE.Mesh>(null);
  const bodyRef = useRef<RapierRigidBody>(null);
  const lastSnap = useRef({ x: 0, z: 0 });

  useFrame(() => {
    const p = playerPosRef.current?.pos;
    if (!p) return;
    // Snap to nearest FOLLOW_SNAP_M so we don't write a transform every frame.
    const sx = Math.round(p.x / FOLLOW_SNAP_M) * FOLLOW_SNAP_M;
    const sz = Math.round(p.z / FOLLOW_SNAP_M) * FOLLOW_SNAP_M;
    if (sx === lastSnap.current.x && sz === lastSnap.current.z) return;
    lastSnap.current.x = sx;
    lastSnap.current.z = sz;
    if (visualRef.current) visualRef.current.position.set(sx, 0, sz);
    if (bodyRef.current) bodyRef.current.setNextKinematicTranslation({ x: sx, y: -0.5, z: sz });
    // Counter the mesh translation in UV space so texture stays world-anchored.
    const uvPerMeter = TEX_REPEAT / TERRAIN_SIZE;
    tex.offset.x = (sx * uvPerMeter) % 1;
    tex.offset.y = (-sz * uvPerMeter) % 1;
  });

  return (
    <>
      <mesh ref={visualRef} geometry={terrainGeom}>
        <meshLambertMaterial map={tex} />
      </mesh>
      <RigidBody
        ref={bodyRef}
        type="kinematicPosition"
        colliders="cuboid"
        position={[0, -0.5, 0]}
      >
        <mesh>
          <boxGeometry args={[GROUND_SIZE, 1, GROUND_SIZE]} />
          <meshLambertMaterial map={tex} transparent opacity={0} />
        </mesh>
      </RigidBody>
    </>
  );
}
