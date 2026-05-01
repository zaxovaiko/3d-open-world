import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
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
  highwayTexture,
  serviceTexture,
  standardRoadTexture,
  streetTexture,
  tramTexture,
  waterTexture,
} from "../world/textures";

export const BUILDING_MAT: Record<BuildingKind, THREE.Material> = {
  house:       new THREE.MeshLambertMaterial({ map: buildingKindTexture("house") }),
  apartments:  new THREE.MeshLambertMaterial({ map: buildingKindTexture("apartments") }),
  office:      new THREE.MeshLambertMaterial({ map: buildingKindTexture("office") }),
  retail:      new THREE.MeshLambertMaterial({ map: buildingKindTexture("retail") }),
  industrial:  new THREE.MeshLambertMaterial({ map: buildingKindTexture("industrial") }),
  warehouse:   new THREE.MeshLambertMaterial({ map: buildingKindTexture("warehouse") }),
  school:      new THREE.MeshLambertMaterial({ map: buildingKindTexture("school") }),
  hospital:    new THREE.MeshLambertMaterial({ map: buildingKindTexture("hospital") }),
  religious:   new THREE.MeshLambertMaterial({ map: buildingKindTexture("religious") }),
  civic:       new THREE.MeshLambertMaterial({ map: buildingKindTexture("civic") }),
  generic:     new THREE.MeshLambertMaterial({ map: buildingKindTexture("generic") }),
};

// River-only material — keep a typed handle so the animator can scroll the UV.
const RIVER_TEX = waterTexture();
const RIVER_MAT = new THREE.MeshBasicMaterial({ map: RIVER_TEX });

// Drives subtle UV scrolling on the river texture so water reads as flowing
// rather than painted on. Mount once in the scene; uses no extra draws.
export function WaterAnimator() {
  useFrame((_, dt) => {
    if (!RIVER_TEX) return;
    RIVER_TEX.offset.y -= dt * 0.04;
    RIVER_TEX.offset.x += dt * 0.012;
    RIVER_TEX.needsUpdate = true;
  });
  return null;
}

export const ROAD_MAT: Record<RoadKind, THREE.Material> = {
  highway: new THREE.MeshBasicMaterial({ map: highwayTexture() }),
  road: new THREE.MeshBasicMaterial({ map: standardRoadTexture() }),
  street: new THREE.MeshBasicMaterial({ map: streetTexture() }),
  service: new THREE.MeshBasicMaterial({ map: serviceTexture() }),
  bike: new THREE.MeshBasicMaterial({ map: bikeTexture() }),
  bus: new THREE.MeshBasicMaterial({ map: busTexture() }),
  tram: new THREE.MeshBasicMaterial({ map: tramTexture() }),
  footway: new THREE.MeshBasicMaterial({ map: footwayTexture() }),
  river: RIVER_MAT,
};

// Tram is drawn last so rails always overlay roads, even when they share y.
const ROAD_ORDER: RoadKind[] = [
  "river", "footway", "bike", "service", "street", "bus", "road", "highway", "tram",
];
const ROAD_RENDER: Record<RoadKind, number> = {
  river: 0, footway: 1, bike: 2, service: 3, street: 4, bus: 5, road: 6, highway: 7, tram: 8,
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

