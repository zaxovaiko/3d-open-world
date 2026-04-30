import { useEffect, useMemo } from "react";
import { RigidBody } from "@react-three/rapier";
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
const TERRAIN_SIZE = 3000;
const TERRAIN_SEGMENTS = 1; // flat — elevation removed

export function Ground() {
  const tex = useMemo(() => {
    const t = groundTexture();
    t.repeat.set(120, 120);
    return t;
  }, []);
  const terrainGeom = useMemo(() => buildTerrainGeometry(TERRAIN_SIZE, TERRAIN_SEGMENTS), []);
  return (
    <>
      <mesh geometry={terrainGeom}>
        <meshLambertMaterial map={tex} />
      </mesh>
      <RigidBody type="fixed" colliders="cuboid" position={[0, -0.5, 0]}>
        <mesh>
          <boxGeometry args={[GROUND_SIZE, 1, GROUND_SIZE]} />
          <meshLambertMaterial map={tex} transparent opacity={0} />
        </mesh>
      </RigidBody>
    </>
  );
}
