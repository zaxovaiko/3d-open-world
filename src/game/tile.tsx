import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { RigidBody } from "@react-three/rapier";
import { Instances, Instance } from "@react-three/drei";
import type { RoadKind, TileData } from "../types";
import type { Projector } from "../world/project";
import { BUILDING_KINDS, type BuildingKind } from "../world/buildings-shared";
import { buildTileInWorker, type Built } from "../world/tile-build-client";
import type { TreeInstance, TreeKind } from "../world/trees";
import {
  bikeTexture,
  buildingKindTexture,
  busTexture,
  footwayTexture,
  groundTexture,
  roadTexture,
  tramTexture,
  waterTexture,
} from "../world/textures";
import { buildTerrainGeometry } from "../world/terrain";

type Props = { tile: TileData; proj: Projector };

const BUILDING_MAT: Record<BuildingKind, THREE.Material> = {
  residential: new THREE.MeshLambertMaterial({ map: buildingKindTexture("residential"), side: THREE.DoubleSide }),
  commercial: new THREE.MeshLambertMaterial({ map: buildingKindTexture("commercial"), side: THREE.DoubleSide }),
  industrial: new THREE.MeshLambertMaterial({ map: buildingKindTexture("industrial"), side: THREE.DoubleSide }),
  civic: new THREE.MeshLambertMaterial({ map: buildingKindTexture("civic"), side: THREE.DoubleSide }),
  generic: new THREE.MeshLambertMaterial({ map: buildingKindTexture("generic"), side: THREE.DoubleSide }),
};

const KIND_MAT: Record<RoadKind, THREE.Material> = {
  car: new THREE.MeshBasicMaterial({ map: roadTexture(), side: THREE.DoubleSide }),
  bike: new THREE.MeshBasicMaterial({ map: bikeTexture(), side: THREE.DoubleSide }),
  bus: new THREE.MeshBasicMaterial({ map: busTexture(), side: THREE.DoubleSide }),
  tram: new THREE.MeshBasicMaterial({ map: tramTexture(), side: THREE.DoubleSide }),
  footway: new THREE.MeshBasicMaterial({ map: footwayTexture(), side: THREE.DoubleSide }),
  river: new THREE.MeshBasicMaterial({ map: waterTexture(), side: THREE.DoubleSide }),
};

function setStatic(o: THREE.Object3D | null) {
  if (!o) return;
  o.matrixAutoUpdate = false;
  o.updateMatrix();
}

const KIND_ORDER: RoadKind[] = ["river", "tram", "footway", "bike", "bus", "car"];
const KIND_RENDER: Record<RoadKind, number> = {
  river: 0, tram: 1, footway: 2, bike: 3, bus: 4, car: 5,
};

export function Tile({ tile, proj }: Props) {
  const [built, setBuilt] = useState<Built | null>(null);

  useEffect(() => {
    const job = buildTileInWorker(tile, proj.origin);
    job.promise
      .then((b) => setBuilt(b))
      .catch(() => {/* cancelled */});
    return () => {
      job.cancel();
      setBuilt(null);
    };
  }, [tile, proj]);

  if (!built) return null;
  const { buildings, roads, trees, peaks } = built;

  return (
    <group ref={setStatic}>
      {BUILDING_KINDS.map((k) => {
        const m = buildings[k];
        if (!m) return null;
        return (
          <mesh key={k} geometry={m.geometry} material={BUILDING_MAT[k]} ref={setStatic} />
        );
      })}
      {KIND_ORDER.map((k) => {
        const g = roads[k];
        if (!g) return null;
        return (
          <mesh
            key={k}
            geometry={g}
            material={KIND_MAT[k]}
            renderOrder={KIND_RENDER[k]}
            ref={setStatic}
          />
        );
      })}
      {peaks.map((p, i) => (
        <group key={`peak${i}`} position={[p.x, 0, p.z]}>
          <mesh position={[0, p.height / 2, 0]}>
            <coneGeometry args={[p.radius, p.height, 18, 4]} />
            <meshLambertMaterial color="#5a5450" />
          </mesh>
          <mesh position={[0, p.height * 0.85, 0]}>
            <coneGeometry args={[p.radius * 0.32, p.height * 0.3, 16, 1]} />
            <meshLambertMaterial color="#f4f7fb" />
          </mesh>
        </group>
      ))}
      <TreeGroups trees={trees} />

    </group>
  );
}

function TreeGroups({ trees }: { trees: TreeInstance[] }) {
  const buckets = useMemo(() => {
    const out: Record<TreeKind, TreeInstance[]> = {
      broadleaf: [],
      conifer: [],
      palm: [],
      bush: [],
    };
    for (const t of trees) out[t.kind].push(t);
    return out;
  }, [trees]);

  return (
    <group>
      {buckets.broadleaf.length > 0 && (
        <>
          <Instances limit={buckets.broadleaf.length} range={buckets.broadleaf.length}>
            <cylinderGeometry args={[0.25, 0.35, 3, 5]} />
            <meshLambertMaterial color="#5b3a1d" />
            {buckets.broadleaf.map((t, i) => (
              <Instance key={i} position={[t.x, 1.5 * t.scale, t.z]} scale={t.scale} />
            ))}
          </Instances>
          <Instances limit={buckets.broadleaf.length} range={buckets.broadleaf.length}>
            <sphereGeometry args={[2, 6, 4]} />
            <meshLambertMaterial color="#3f7a3a" />
            {buckets.broadleaf.map((t, i) => (
              <Instance key={i} position={[t.x, 4.5 * t.scale, t.z]} scale={t.scale} />
            ))}
          </Instances>
        </>
      )}
      {buckets.conifer.length > 0 && (
        <>
          <Instances limit={buckets.conifer.length} range={buckets.conifer.length}>
            <cylinderGeometry args={[0.18, 0.28, 4, 5]} />
            <meshLambertMaterial color="#3a2614" />
            {buckets.conifer.map((t, i) => (
              <Instance key={i} position={[t.x, 2 * t.scale, t.z]} scale={t.scale} />
            ))}
          </Instances>
          <Instances limit={buckets.conifer.length} range={buckets.conifer.length}>
            <coneGeometry args={[1.8, 6, 7]} />
            <meshLambertMaterial color="#1f5a32" />
            {buckets.conifer.map((t, i) => (
              <Instance key={i} position={[t.x, 6 * t.scale, t.z]} scale={t.scale} />
            ))}
          </Instances>
        </>
      )}
      {buckets.palm.length > 0 && (
        <>
          <Instances limit={buckets.palm.length} range={buckets.palm.length}>
            <cylinderGeometry args={[0.18, 0.22, 6, 6]} />
            <meshLambertMaterial color="#7a5a36" />
            {buckets.palm.map((t, i) => (
              <Instance key={i} position={[t.x, 3 * t.scale, t.z]} scale={t.scale} />
            ))}
          </Instances>
          <Instances limit={buckets.palm.length} range={buckets.palm.length}>
            <coneGeometry args={[2.2, 0.9, 8]} />
            <meshLambertMaterial color="#4a8a3c" />
            {buckets.palm.map((t, i) => (
              <Instance key={i} position={[t.x, 6.4 * t.scale, t.z]} scale={t.scale} />
            ))}
          </Instances>
        </>
      )}
      {buckets.bush.length > 0 && (
        <Instances limit={buckets.bush.length} range={buckets.bush.length}>
          <sphereGeometry args={[1.2, 6, 4]} />
          <meshLambertMaterial color="#4f8a3c" />
          {buckets.bush.map((t, i) => (
            <Instance key={i} position={[t.x, 1.0 * t.scale, t.z]} scale={t.scale} />
          ))}
        </Instances>
      )}
    </group>
  );
}

export const GROUND_SIZE = 4000;
const TERRAIN_SIZE = 6000;
const TERRAIN_SEGMENTS = 200; // ~30k tris

export function Ground() {
  const tex = useMemo(() => {
    const t = groundTexture();
    t.repeat.set(120, 120);
    return t;
  }, []);
  // Visible terrain mesh (hills/mountains outside the flat zone).
  const terrainGeom = useMemo(() => buildTerrainGeometry(TERRAIN_SIZE, TERRAIN_SEGMENTS), []);
  return (
    <>
      <mesh geometry={terrainGeom} receiveShadow>
        <meshLambertMaterial map={tex} />
      </mesh>
      {/* Flat physics ground covering the playable flat zone. */}
      <RigidBody type="fixed" colliders="cuboid" position={[0, -0.5, 0]}>
        <mesh>
          <boxGeometry args={[GROUND_SIZE, 1, GROUND_SIZE]} />
          <meshLambertMaterial map={tex} transparent opacity={0} />
        </mesh>
      </RigidBody>
    </>
  );
}
