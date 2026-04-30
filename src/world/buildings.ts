// Backwards-compat re-exports + main-thread helpers.
// Heavy geometry construction lives in tile-worker.ts.
export {
  BUILDING_KINDS,
  classifyBuilding,
  type BuildingKind,
  type BuildingAABB,
} from "./buildings-shared";

export type BuildingMesh = {
  geometry: import("three").BufferGeometry;
  count: number;
  aabbs: import("./buildings-shared").BuildingAABB[];
};
