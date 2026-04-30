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

// Road sub-classes per OSM highway tag:
// highway → motorway, trunk, primary (and *_link)
// road    → secondary, tertiary (and *_link)
// street  → residential, unclassified, living_street
// service → service, track
export type RoadKind =
  | "highway" | "road" | "street" | "service"
  | "bike" | "bus" | "tram" | "footway" | "river";

// Network-side tile shape: raw Overpass response + tile coords. Element
// classification (buildings/roads/trees/peaks) happens inside the worker so
// the main thread never iterates the OSM element list.
export type TileData = {
  key: TileKey;
  tx: number;
  tz: number;
  data: OverpassResponse;
};
