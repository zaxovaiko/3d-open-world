export type LatLon = { lat: number; lon: number };

export type OsmTags = Record<string, string>;

export type OsmGeomNode = { lat: number; lon: number };

export type OsmWay = {
  type: "way";
  id: number;
  tags?: OsmTags;
  geometry: OsmGeomNode[];
};

export type OsmNode = {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: OsmTags;
};

export type OsmElement = OsmWay | OsmNode;

export type OverpassResponse = {
  elements: OsmElement[];
};

export type TileKey = string; // `${tx}_${tz}`

export type RoadKind = "car" | "bike" | "bus" | "tram" | "footway" | "river";

export type TileData = {
  key: TileKey;
  tx: number;
  tz: number;
  buildings: OsmWay[];
  roads: Record<RoadKind, OsmWay[]>;
  trees: OsmNode[];
  peaks: OsmNode[];
};
