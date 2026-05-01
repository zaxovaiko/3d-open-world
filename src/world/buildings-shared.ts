// Coarse-grained building kinds. Each maps to a distinct facade texture and,
// where helpful, a distinct roof shape in the worker. Mapping below is
// derived from OSM `building=*` values — see classifyBuilding().
export type BuildingKind =
  | "house"
  | "apartments"
  | "office"
  | "retail"
  | "industrial"
  | "warehouse"
  | "school"
  | "hospital"
  | "religious"
  | "civic"
  | "generic";

export const BUILDING_KINDS: BuildingKind[] = [
  "house",
  "apartments",
  "office",
  "retail",
  "industrial",
  "warehouse",
  "school",
  "hospital",
  "religious",
  "civic",
  "generic",
];

export type BuildingAABB = {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
};

const HOUSE = new Set([
  "house", "detached", "semidetached_house", "bungalow", "cabin",
  "static_caravan", "terrace", "farm",
]);
const APARTMENTS = new Set([
  "apartments", "residential", "dormitory", "barracks",
]);
const OFFICE = new Set(["office", "commercial", "hotel"]);
const RETAIL = new Set(["retail", "supermarket", "kiosk", "shop", "mall"]);
const INDUSTRIAL = new Set(["industrial", "factory", "manufacture"]);
const WAREHOUSE = new Set([
  "warehouse", "hangar", "garage", "garages", "storage_tank", "silo",
]);
const SCHOOL = new Set([
  "school", "university", "college", "kindergarten",
]);
const HOSPITAL = new Set(["hospital", "clinic"]);
const RELIGIOUS = new Set([
  "church", "cathedral", "chapel", "mosque", "synagogue", "temple", "shrine",
]);
const CIVIC = new Set([
  "government", "public", "civic", "train_station", "transportation",
  "stadium", "museum", "library", "fire_station", "police", "courthouse",
  "townhall",
]);

export function classifyBuilding(tags: Record<string, string> | undefined): BuildingKind {
  const b = tags?.building;
  if (!b || b === "yes" || b === "building") return "generic";
  if (HOUSE.has(b)) return "house";
  if (APARTMENTS.has(b)) return "apartments";
  if (OFFICE.has(b)) return "office";
  if (RETAIL.has(b)) return "retail";
  if (INDUSTRIAL.has(b)) return "industrial";
  if (WAREHOUSE.has(b)) return "warehouse";
  if (SCHOOL.has(b)) return "school";
  if (HOSPITAL.has(b)) return "hospital";
  if (RELIGIOUS.has(b)) return "religious";
  if (CIVIC.has(b)) return "civic";
  return "generic";
}
