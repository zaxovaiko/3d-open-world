import * as THREE from "three";

let buildingTex: THREE.CanvasTexture | null = null;
const kindTexCache: Partial<Record<string, THREE.CanvasTexture>> = {};
let roadTex: THREE.CanvasTexture | null = null;
let groundTex: THREE.CanvasTexture | null = null;
let bikeTex: THREE.CanvasTexture | null = null;
let busTex: THREE.CanvasTexture | null = null;
let tramTex: THREE.CanvasTexture | null = null;
let footwayTex: THREE.CanvasTexture | null = null;
let waterTex: THREE.CanvasTexture | null = null;

export function buildingTexture(): THREE.CanvasTexture {
  if (buildingTex) return buildingTex;
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c9c4bd";
  g.fillRect(0, 0, W, H);
  // Window grid: 4 cols x 4 rows
  const cols = 4, rows = 4;
  const cw = W / cols;
  const rh = H / rows;
  g.fillStyle = "#3a4554";
  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      const x = cc * cw + cw * 0.2;
      const y = r * rh + rh * 0.2;
      g.fillRect(x, y, cw * 0.6, rh * 0.55);
    }
  }
  // Subtle horizontal floor lines
  g.strokeStyle = "rgba(0,0,0,0.15)";
  g.lineWidth = 1;
  for (let r = 1; r < rows; r++) {
    g.beginPath();
    g.moveTo(0, r * rh);
    g.lineTo(W, r * rh);
    g.stroke();
  }
  buildingTex = new THREE.CanvasTexture(c);
  buildingTex.wrapS = THREE.RepeatWrapping;
  buildingTex.wrapT = THREE.RepeatWrapping;
  buildingTex.anisotropy = 4;
  return buildingTex;
}

type BuildingKindStyle = {
  base: string;
  window: string;
  windowCols: number;
  windowRows: number;
  windowFill: number; // 0..1 fraction of cell taken by window
};

const KIND_STYLES: Record<string, BuildingKindStyle> = {
  residential: { base: "#d8b079", window: "#3a2e22", windowCols: 4, windowRows: 4, windowFill: 0.55 },
  commercial: { base: "#6a8fb3", window: "#0f1d2e", windowCols: 6, windowRows: 6, windowFill: 0.85 },
  industrial: { base: "#8b8a85", window: "#2a2a26", windowCols: 3, windowRows: 2, windowFill: 0.4 },
  civic: { base: "#e8dcc4", window: "#5b4a32", windowCols: 4, windowRows: 5, windowFill: 0.5 },
  generic: { base: "#c9c4bd", window: "#3a4554", windowCols: 4, windowRows: 4, windowFill: 0.6 },
};

export function buildingKindTexture(kind: string): THREE.CanvasTexture {
  if (kindTexCache[kind]) return kindTexCache[kind] as THREE.CanvasTexture;
  const s = KIND_STYLES[kind] ?? KIND_STYLES.generic;
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = s.base;
  g.fillRect(0, 0, W, H);
  // Window grid
  const cw = W / s.windowCols;
  const rh = H / s.windowRows;
  g.fillStyle = s.window;
  for (let r = 0; r < s.windowRows; r++) {
    for (let cc = 0; cc < s.windowCols; cc++) {
      const padX = (cw * (1 - s.windowFill)) / 2;
      const padY = (rh * (1 - s.windowFill)) / 2;
      g.fillRect(cc * cw + padX, r * rh + padY, cw * s.windowFill, rh * s.windowFill);
    }
  }
  // Subtle floor lines
  g.strokeStyle = "rgba(0,0,0,0.15)";
  g.lineWidth = 1;
  for (let r = 1; r < s.windowRows; r++) {
    g.beginPath();
    g.moveTo(0, r * rh);
    g.lineTo(W, r * rh);
    g.stroke();
  }
  // Industrial corrugated overlay
  if (kind === "industrial") {
    g.strokeStyle = "rgba(0,0,0,0.18)";
    for (let x = 0; x < W; x += 6) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
  }
  // Civic stone overlay (random rectangles)
  if (kind === "civic") {
    g.strokeStyle = "rgba(0,0,0,0.15)";
    for (let r = 0; r < s.windowRows; r++) {
      g.beginPath();
      g.moveTo(0, (r + 0.5) * rh);
      g.lineTo(W, (r + 0.5) * rh);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  kindTexCache[kind] = tex;
  return tex;
}

export function roadTexture(): THREE.CanvasTexture {
  if (roadTex) return roadTex;
  const W = 64, H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2b2b2b";
  g.fillRect(0, 0, W, H);
  // Speckle for asphalt
  for (let i = 0; i < 800; i++) {
    g.fillStyle = `rgba(${20 + Math.random() * 40},${20 + Math.random() * 40},${20 + Math.random() * 40},0.6)`;
    g.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  // Center dashed line
  g.fillStyle = "#e8d96b";
  const dashLen = 32;
  const gap = 32;
  for (let y = 0; y < H; y += dashLen + gap) {
    g.fillRect(W / 2 - 1.5, y, 3, dashLen);
  }
  roadTex = new THREE.CanvasTexture(c);
  roadTex.wrapS = THREE.RepeatWrapping;
  roadTex.wrapT = THREE.RepeatWrapping;
  roadTex.anisotropy = 4;
  return roadTex;
}

export function bikeTexture(): THREE.CanvasTexture {
  if (bikeTex) return bikeTex;
  const W = 64, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#7a1c1c";
  g.fillRect(0, 0, W, H);
  // White edge stripes
  g.fillStyle = "#ffffff";
  g.fillRect(2, 0, 2, H);
  g.fillRect(W - 4, 0, 2, H);
  // Bike emblem
  g.strokeStyle = "#ffffff";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(W / 2 - 8, H / 2 + 14, 7, 0, Math.PI * 2);
  g.arc(W / 2 + 8, H / 2 + 14, 7, 0, Math.PI * 2);
  g.stroke();
  bikeTex = new THREE.CanvasTexture(c);
  bikeTex.wrapS = THREE.RepeatWrapping;
  bikeTex.wrapT = THREE.RepeatWrapping;
  bikeTex.anisotropy = 4;
  return bikeTex;
}

export function busTexture(): THREE.CanvasTexture {
  if (busTex) return busTex;
  const W = 64, H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#a82929";
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 600; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.2})`;
    g.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  // BUS text band
  g.fillStyle = "#ffffff";
  g.font = "bold 18px sans-serif";
  g.textAlign = "center";
  g.fillText("BUS", W / 2, 130);
  busTex = new THREE.CanvasTexture(c);
  busTex.wrapS = THREE.RepeatWrapping;
  busTex.wrapT = THREE.RepeatWrapping;
  busTex.anisotropy = 4;
  return busTex;
}

export function tramTexture(): THREE.CanvasTexture {
  if (tramTex) return tramTex;
  const W = 64, H = 64;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a3530";
  g.fillRect(0, 0, W, H);
  // Two parallel rails (vertical = along travel)
  g.fillStyle = "#aaaaaa";
  g.fillRect(W * 0.28, 0, 3, H);
  g.fillRect(W * 0.68, 0, 3, H);
  // Crossties (horizontal)
  g.fillStyle = "#241f1a";
  for (let y = 0; y < H; y += 12) {
    g.fillRect(W * 0.18, y, W * 0.62, 3);
  }
  tramTex = new THREE.CanvasTexture(c);
  tramTex.wrapS = THREE.RepeatWrapping;
  tramTex.wrapT = THREE.RepeatWrapping;
  tramTex.anisotropy = 4;
  return tramTex;
}

export function footwayTexture(): THREE.CanvasTexture {
  if (footwayTex) return footwayTex;
  const W = 64, H = 64;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#b9b3a8";
  g.fillRect(0, 0, W, H);
  // Paver grid
  g.strokeStyle = "rgba(0,0,0,0.25)";
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    g.beginPath();
    g.moveTo(0, (i * H) / 4);
    g.lineTo(W, (i * H) / 4);
    g.stroke();
    g.beginPath();
    g.moveTo((i * W) / 4, 0);
    g.lineTo((i * W) / 4, H);
    g.stroke();
  }
  footwayTex = new THREE.CanvasTexture(c);
  footwayTex.wrapS = THREE.RepeatWrapping;
  footwayTex.wrapT = THREE.RepeatWrapping;
  footwayTex.anisotropy = 4;
  return footwayTex;
}

export function waterTexture(): THREE.CanvasTexture {
  if (waterTex) return waterTex;
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1a4a78");
  grad.addColorStop(0.5, "#2a6098");
  grad.addColorStop(1, "#1a4a78");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Wavy highlights
  g.strokeStyle = "rgba(255,255,255,0.18)";
  g.lineWidth = 1.5;
  for (let i = 0; i < 18; i++) {
    g.beginPath();
    const y = Math.random() * H;
    g.moveTo(0, y);
    for (let x = 0; x <= W; x += 8) {
      g.lineTo(x, y + Math.sin(x * 0.15 + i) * 2);
    }
    g.stroke();
  }
  waterTex = new THREE.CanvasTexture(c);
  waterTex.wrapS = THREE.RepeatWrapping;
  waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.anisotropy = 4;
  return waterTex;
}

export function groundTexture(): THREE.CanvasTexture {
  if (groundTex) return groundTex;
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4f7a3a";
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 1500; i++) {
    const r = 60 + Math.random() * 50;
    const gr = 100 + Math.random() * 50;
    const b = 40 + Math.random() * 30;
    g.fillStyle = `rgb(${r},${gr},${b})`;
    g.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  groundTex = new THREE.CanvasTexture(c);
  groundTex.wrapS = THREE.RepeatWrapping;
  groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(200, 200);
  groundTex.anisotropy = 4;
  return groundTex;
}
