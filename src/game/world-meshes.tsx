import { useMemo } from "react";
import * as THREE from "three";
import type { RoadKind } from "../types";
import { BUILDING_KINDS, type BuildingKind } from "../world/buildings-shared";
import type { Built } from "../world/tile-build-client";
import type { TreeInstance, TreeKind } from "../world/trees";
import { TreeFleet } from "./tree-fleet";
import {
  bikeTexture,
  buildingKindTexture,
  busTexture,
  footwayTexture,
  roadTexture,
  tramTexture,
  waterTexture,
} from "../world/textures";

const BUILDING_MAT: Record<BuildingKind, THREE.Material> = {
  residential: new THREE.MeshLambertMaterial({ map: buildingKindTexture("residential") }),
  commercial: new THREE.MeshLambertMaterial({ map: buildingKindTexture("commercial") }),
  industrial: new THREE.MeshLambertMaterial({ map: buildingKindTexture("industrial") }),
  civic: new THREE.MeshLambertMaterial({ map: buildingKindTexture("civic") }),
  generic: new THREE.MeshLambertMaterial({ map: buildingKindTexture("generic") }),
};

const ROAD_MAT: Record<RoadKind, THREE.Material> = {
  car: new THREE.MeshBasicMaterial({ map: roadTexture() }),
  bike: new THREE.MeshBasicMaterial({ map: bikeTexture() }),
  bus: new THREE.MeshBasicMaterial({ map: busTexture() }),
  tram: new THREE.MeshBasicMaterial({ map: tramTexture() }),
  footway: new THREE.MeshBasicMaterial({ map: footwayTexture() }),
  river: new THREE.MeshBasicMaterial({ map: waterTexture() }),
};

const ROAD_ORDER: RoadKind[] = ["river", "tram", "footway", "bike", "bus", "car"];
const ROAD_RENDER: Record<RoadKind, number> = {
  river: 0, tram: 1, footway: 2, bike: 3, bus: 4, car: 5,
};

export type BuiltEntry = { key: string; data: Built };

type Props = { built: BuiltEntry[] };

// Per-tile-per-kind meshes with shared global materials + Three's auto-frustum
// cull. Each tile's geometry has its own bounding sphere, so off-screen tiles
// are skipped at draw time. No CPU merge cost on tile arrival.
//
// Stable React keys (tile key, not array index) — eviction in the middle of
// the active set must not unmount unrelated meshes.
export function WorldMeshes({ built }: Props) {
  const treeBuckets = useMemo(() => {
    const out: Record<TreeKind, TreeInstance[]> = {
      broadleaf: [], conifer: [], palm: [], bush: [],
    };
    for (const e of built) for (const t of e.data.trees) out[t.kind].push(t);
    return out;
  }, [built]);

  return (
    <group matrixAutoUpdate={false}>
      {built.flatMap((e) =>
        BUILDING_KINDS.map((k) => {
          const m = e.data.buildings[k];
          if (!m) return null;
          return (
            <mesh
              key={`b_${e.key}_${k}`}
              geometry={m.geometry}
              material={BUILDING_MAT[k]}
              matrixAutoUpdate={false}
            />
          );
        }),
      )}
      {built.flatMap((e) =>
        ROAD_ORDER.map((k) => {
          const g = e.data.roads[k];
          if (!g) return null;
          return (
            <mesh
              key={`r_${e.key}_${k}`}
              geometry={g}
              material={ROAD_MAT[k]}
              renderOrder={ROAD_RENDER[k]}
              matrixAutoUpdate={false}
            />
          );
        }),
      )}
      <TreeFleet buckets={treeBuckets} />
    </group>
  );
}

