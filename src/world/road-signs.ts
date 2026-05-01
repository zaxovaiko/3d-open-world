import * as THREE from "three";

// European road signs — Vienna Convention pictograms drawn on a 256² canvas
// with transparent background. Each kind maps to a single texture; render is
// a billboard plane on a procedural pole.

export type SignKind =
  | "stop"
  | "give_way"
  | "no_entry"
  | "priority"
  | "roundabout"
  | "speed_30"
  | "speed_50"
  | "speed_70"
  | "speed_90"
  | "warning"
  | "pedestrian"
  | "generic";

export const SIGN_KINDS: SignKind[] = [
  "stop", "give_way", "no_entry", "priority", "roundabout",
  "speed_30", "speed_50", "speed_70", "speed_90",
  "warning", "pedestrian", "generic",
];

const SIZE = 256;

// Map OSM `traffic_sign` value (and a few related tags) to a sign kind.
// Handles bare values (`stop`, `give_way`) and country-prefixed Vienna codes
// (`DE:206`, `FR:AB4`, etc.) — codes 205/206/267/306/215 are stable across
// most EU country prefixes.
export function classifySign(tags: Record<string, string> | undefined): SignKind {
  if (!tags) return "generic";
  const raw = (tags.traffic_sign ?? "").toLowerCase();
  if (!raw) return "generic";
  // Speed limits: explicit `maxspeed` value on tag, or `*:274-30` style.
  const ms = raw.match(/(?:maxspeed|274[-:])(\d+)/);
  if (ms) {
    const v = parseInt(ms[1], 10);
    if (v <= 35) return "speed_30";
    if (v <= 60) return "speed_50";
    if (v <= 80) return "speed_70";
    return "speed_90";
  }
  if (raw.includes("stop") || /(?::|^)206\b/.test(raw)) return "stop";
  if (raw.includes("give_way") || raw.includes("yield") || /(?::|^)205\b/.test(raw)) return "give_way";
  if (raw.includes("no_entry") || raw.includes("no_through") || /(?::|^)267\b/.test(raw)) return "no_entry";
  if (raw.includes("priority") || /(?::|^)306\b/.test(raw)) return "priority";
  if (raw.includes("roundabout") || /(?::|^)215\b/.test(raw)) return "roundabout";
  if (raw.includes("crossing") || raw.includes("pedestrian") || /(?::|^)350/.test(raw) || /(?::|^)101/.test(raw))
    return "pedestrian";
  if (raw.includes("warning") || raw.includes("danger") || /(?::|^)1\d{2}\b/.test(raw)) return "warning";
  return "generic";
}

const cache: Partial<Record<SignKind, THREE.CanvasTexture>> = {};

export function signTexture(kind: SignKind): THREE.CanvasTexture {
  const hit = cache[kind];
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = SIZE; c.height = SIZE;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, SIZE, SIZE);
  drawSign(g, kind);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 16;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  cache[kind] = tex;
  return tex;
}

function drawSign(g: CanvasRenderingContext2D, kind: SignKind) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  switch (kind) {
    case "stop":
      drawOctagon(g, cx, cy, SIZE * 0.46, "#cc1417", "#ffffff", 8);
      drawText(g, "STOP", cx, cy + 18, "#ffffff", 56, "bold");
      break;
    case "give_way":
      drawTriangleDown(g, cx, cy, SIZE * 0.45, "#ffffff", "#cc1417", 14);
      break;
    case "no_entry":
      drawCircle(g, cx, cy, SIZE * 0.42, "#cc1417", "#ffffff", 8);
      g.fillStyle = "#ffffff";
      g.fillRect(cx - SIZE * 0.30, cy - SIZE * 0.07, SIZE * 0.60, SIZE * 0.14);
      break;
    case "priority":
      // Yellow diamond (square rotated 45°) with white border.
      drawDiamond(g, cx, cy, SIZE * 0.42, "#fdc202", "#1a1a1a", 8);
      g.save();
      g.translate(cx, cy);
      g.rotate(Math.PI / 4);
      g.strokeStyle = "#ffffff";
      g.lineWidth = 12;
      g.strokeRect(-SIZE * 0.28, -SIZE * 0.28, SIZE * 0.56, SIZE * 0.56);
      g.restore();
      break;
    case "roundabout":
      drawCircle(g, cx, cy, SIZE * 0.42, "#1857c4", null, 0);
      g.strokeStyle = "#ffffff";
      g.lineWidth = 14;
      drawArrowsRoundabout(g, cx, cy, SIZE * 0.22);
      break;
    case "speed_30":
      drawSpeedLimit(g, cx, cy, "30");
      break;
    case "speed_50":
      drawSpeedLimit(g, cx, cy, "50");
      break;
    case "speed_70":
      drawSpeedLimit(g, cx, cy, "70");
      break;
    case "speed_90":
      drawSpeedLimit(g, cx, cy, "90");
      break;
    case "pedestrian":
      // Blue square with white pedestrian crossing pictogram.
      g.fillStyle = "#1857c4";
      g.fillRect(cx - SIZE * 0.42, cy - SIZE * 0.42, SIZE * 0.84, SIZE * 0.84);
      g.fillStyle = "#ffffff";
      // Stripes (zebra crossing).
      for (let i = 0; i < 4; i++) {
        g.fillRect(cx - SIZE * 0.30 + i * SIZE * 0.16, cy + SIZE * 0.05, SIZE * 0.10, SIZE * 0.30);
      }
      // Walker silhouette (simple).
      g.beginPath();
      g.arc(cx - 8, cy - SIZE * 0.20, 14, 0, Math.PI * 2);
      g.fill();
      g.fillRect(cx - 18, cy - SIZE * 0.10, 30, 50);
      break;
    case "warning":
      drawTriangleUp(g, cx, cy, SIZE * 0.45, "#ffffff", "#cc1417", 14);
      drawText(g, "!", cx, cy + 30, "#1a1a1a", 92, "bold");
      break;
    default:
      // Generic blue informational square.
      g.fillStyle = "#1857c4";
      g.fillRect(cx - SIZE * 0.40, cy - SIZE * 0.40, SIZE * 0.80, SIZE * 0.80);
      g.strokeStyle = "#ffffff";
      g.lineWidth = 8;
      g.strokeRect(cx - SIZE * 0.36, cy - SIZE * 0.36, SIZE * 0.72, SIZE * 0.72);
      drawText(g, "i", cx, cy + 24, "#ffffff", 90, "bold");
      break;
  }
}

function drawSpeedLimit(g: CanvasRenderingContext2D, cx: number, cy: number, n: string) {
  drawCircle(g, cx, cy, SIZE * 0.42, "#ffffff", "#cc1417", 18);
  drawText(g, n, cx, cy + 24, "#1a1a1a", 96, "bold");
}

function drawCircle(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string | null, sw: number) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = sw;
    g.stroke();
  }
}

function drawOctagon(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string, sw: number) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + i * Math.PI / 4;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.strokeStyle = stroke; g.lineWidth = sw; g.stroke();
}

function drawTriangleUp(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string, sw: number) {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r * 0.866, y + r * 0.5);
  g.lineTo(x - r * 0.866, y + r * 0.5);
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.strokeStyle = stroke; g.lineWidth = sw; g.stroke();
}

function drawTriangleDown(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string, sw: number) {
  g.beginPath();
  g.moveTo(x, y + r);
  g.lineTo(x + r * 0.866, y - r * 0.5);
  g.lineTo(x - r * 0.866, y - r * 0.5);
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.strokeStyle = stroke; g.lineWidth = sw; g.stroke();
}

function drawDiamond(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string, sw: number) {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.strokeStyle = stroke; g.lineWidth = sw; g.stroke();
}

function drawText(g: CanvasRenderingContext2D, t: string, x: number, y: number, color: string, px: number, weight: string) {
  g.fillStyle = color;
  g.font = `${weight} ${px}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText(t, x, y);
}

function drawArrowsRoundabout(g: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  // Three curved arrows around center forming a counter-clockwise loop
  // (Vienna Convention sign D3 — direction varies per country; this matches
  // continental EU right-hand traffic).
  for (let i = 0; i < 3; i++) {
    const start = i * (Math.PI * 2 / 3) + 0.3;
    const end = start + (Math.PI * 2 / 3) - 0.6;
    g.beginPath();
    g.arc(cx, cy, r, start, end, false);
    g.stroke();
    // Arrowhead at end.
    const ax = cx + r * Math.cos(end);
    const ay = cy + r * Math.sin(end);
    const tx = -Math.sin(end);
    const ty = Math.cos(end);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(ax + tx * 14 - Math.cos(end) * 14, ay + ty * 14 - Math.sin(end) * 14);
    g.lineTo(ax - tx * 14 - Math.cos(end) * 14, ay - ty * 14 - Math.sin(end) * 14);
    g.closePath();
    g.fillStyle = "#ffffff";
    g.fill();
  }
}
