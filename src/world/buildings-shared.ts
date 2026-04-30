export type BuildingKind =
  | "residential"
  | "commercial"
  | "industrial"
  | "civic"
  | "generic";

export const BUILDING_KINDS: BuildingKind[] = [
  "residential",
  "commercial",
  "industrial",
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

const RESIDENTIAL = new Set([
  "residential", "house", "apartments", "terrace", "dormitory",
  "detached", "semidetached_house", "bungalow", "cabin", "static_caravan",
]);
const COMMERCIAL = new Set([
  "commercial", "retail", "office", "supermarket", "kiosk", "hotel", "shop",
]);
const INDUSTRIAL = new Set([
  "industrial", "warehouse", "factory", "manufacture", "hangar",
  "garage", "garages", "storage_tank", "silo",
]);
const CIVIC = new Set([
  "school", "hospital", "university", "college", "kindergarten",
  "church", "cathedral", "mosque", "synagogue", "temple", "chapel",
  "government", "public", "civic", "train_station", "transportation",
  "stadium", "museum", "library",
]);

export function classifyBuilding(tags: Record<string, string> | undefined): BuildingKind {
  const b = tags?.building;
  if (!b || b === "yes") return "generic";
  if (RESIDENTIAL.has(b)) return "residential";
  if (COMMERCIAL.has(b)) return "commercial";
  if (INDUSTRIAL.has(b)) return "industrial";
  if (CIVIC.has(b)) return "civic";
  return "generic";
}
