import * as THREE from "three";

// Hi-res canvas textures + max anisotropy. Textures generate once at startup
// and bind once; mip-mapping handles distance + GPU bandwidth cost. Frame
// cost is unchanged from the previous low-res versions because samplers
// pick a lower mip level for distant fragments automatically.

let buildingTex: THREE.CanvasTexture | null = null;
const kindTexCache: Partial<Record<string, THREE.CanvasTexture>> = {};
let roadTex: THREE.CanvasTexture | null = null;
let groundTex: THREE.CanvasTexture | null = null;
let bikeTex: THREE.CanvasTexture | null = null;
let busTex: THREE.CanvasTexture | null = null;
let tramTex: THREE.CanvasTexture | null = null;
let footwayTex: THREE.CanvasTexture | null = null;
let waterTex: THREE.CanvasTexture | null = null;

const ANISO = 16; // Three clamps to renderer.capabilities.getMaxAnisotropy().

function tuneTexture(tex: THREE.CanvasTexture) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = ANISO;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
}

function hashKind(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hexToRGBA(hex: string, alpha: number): string {
  const v = hex.replace("#", "");
  const r = parseInt(v.substring(0, 2), 16);
  const g = parseInt(v.substring(2, 4), 16);
  const b = parseInt(v.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Mulberry32 PRNG so noise is deterministic per call (no GC churn from Math.random).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildingTexture(): THREE.CanvasTexture {
  if (buildingTex) return buildingTex;
  const W = 512, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c9c4bd";
  g.fillRect(0, 0, W, H);
  const cols = 8, rows = 8;
  const cw = W / cols, rh = H / rows;
  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      g.fillStyle = "#3a4554";
      g.fillRect(cc * cw + cw * 0.18, r * rh + rh * 0.18, cw * 0.64, rh * 0.6);
    }
  }
  buildingTex = new THREE.CanvasTexture(c);
  tuneTexture(buildingTex);
  return buildingTex;
}

type BuildingKindStyle = {
  base: string;
  baseAlt: string;
  window: string;
  windowLit: string;
  windowCols: number;
  windowRows: number;
  windowFill: number;
  // Optional decorative motifs drawn after the window grid.
  brickCourse?: boolean; // horizontal brick rows over base
  vSiding?: boolean; // vertical wood siding
  metalRibs?: boolean; // industrial corrugated metal stripes
  domeArch?: boolean; // arched window tops (religious / civic)
  trimColor?: string; // floor-slab trim color override
};

const KIND_STYLES: Record<string, BuildingKindStyle> = {
  // Warm earth tones, 1-2 stories, small windows, vertical wood siding.
  house:       { base: "#cf9a5a", baseAlt: "#b6864a", window: "#2c2014", windowLit: "#f0c46a", windowCols: 4, windowRows: 4,  windowFill: 0.5,  vSiding: true },
  // Brick mid-rise, repeating window grid, brick courses.
  apartments:  { base: "#a3543e", baseAlt: "#8a4733", window: "#221512", windowLit: "#e8b566", windowCols: 8, windowRows: 12, windowFill: 0.55, brickCourse: true, trimColor: "#5a2c1f" },
  // Glass curtain wall — large lit windows, cool tones.
  office:      { base: "#5b7da0", baseAlt: "#496789", window: "#0a1626", windowLit: "#9bc0e0", windowCols: 14, windowRows: 18, windowFill: 0.92 },
  // Bright street level, big shop windows up top, warm signage colors.
  retail:      { base: "#d97a4a", baseAlt: "#b86237", window: "#1c0e08", windowLit: "#ffd28a", windowCols: 6, windowRows: 5,  windowFill: 0.75, trimColor: "#3a1d0e" },
  // Beige concrete with dark window slits, pipework hint.
  industrial:  { base: "#8b8a85", baseAlt: "#6f6e69", window: "#1d1d1a", windowLit: "#3e3e36", windowCols: 6, windowRows: 4,  windowFill: 0.45, metalRibs: true },
  // Corrugated metal warehouse, wide ribs, sparse small windows.
  warehouse:   { base: "#7d8794", baseAlt: "#646f7d", window: "#161a1f", windowLit: "#2f3540", windowCols: 8, windowRows: 2,  windowFill: 0.35, metalRibs: true },
  // Red-brick with white trim, regular tall windows.
  school:      { base: "#b65a3e", baseAlt: "#9a4a31", window: "#1d1410", windowLit: "#f1d77a", windowCols: 8, windowRows: 6,  windowFill: 0.55, brickCourse: true, trimColor: "#f0eadf" },
  // Cream hospital block, pale green window glass, frequent window grid.
  hospital:    { base: "#e9e3d6", baseAlt: "#d8d0c0", window: "#3a4a3a", windowLit: "#cfe7d0", windowCols: 10, windowRows: 9,  windowFill: 0.6,  trimColor: "#a5b59b" },
  // Stone facade, arched stained-glass windows.
  religious:   { base: "#bdb39a", baseAlt: "#a59a82", window: "#3a2c4a", windowLit: "#9a6cd0", windowCols: 4, windowRows: 4,  windowFill: 0.45, domeArch: true, trimColor: "#766b54" },
  // Limestone civic block, repeating tall arched windows.
  civic:       { base: "#e8dcc4", baseAlt: "#cfc2a4", window: "#5b4a32", windowLit: "#cdb98a", windowCols: 10, windowRows: 8,  windowFill: 0.55, domeArch: true, trimColor: "#a89770" },
  // Neutral fallback.
  generic:     { base: "#c9c4bd", baseAlt: "#b6b1aa", window: "#3a4554", windowLit: "#9aa9bd", windowCols: 8, windowRows: 10, windowFill: 0.6 },
};

export function buildingKindTexture(kind: string): THREE.CanvasTexture {
  if (kindTexCache[kind]) return kindTexCache[kind] as THREE.CanvasTexture;
  const s = KIND_STYLES[kind] ?? KIND_STYLES.generic;
  const W = 512, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;

  // Vertical band gradient so the wall isn't a flat colour.
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, s.base);
  grad.addColorStop(1, s.baseAlt);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  const r = rng(hashKind(kind) + s.windowCols * 13 + s.windowRows);

  // Vertical wood siding (houses) — drawn under the window grid.
  if (s.vSiding) {
    g.strokeStyle = "rgba(0,0,0,0.16)";
    g.lineWidth = 1;
    for (let x = 0; x < W; x += 12) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
  }

  // Horizontal brick courses (apartments / school) — alternating offset rows.
  if (s.brickCourse) {
    g.strokeStyle = "rgba(0,0,0,0.18)";
    g.lineWidth = 1;
    const courseH = 10;
    for (let y = 0; y < H; y += courseH) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
      const offset = (y / courseH) % 2 === 0 ? 0 : 16;
      for (let x = offset; x < W; x += 32) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y + courseH);
        g.stroke();
      }
    }
  }

  // Window grid with deterministic per-window lit/dark variation.
  const cw = W / s.windowCols;
  const rh = H / s.windowRows;
  const litChance = (kind === "office") ? 0.32
    : (kind === "civic" || kind === "retail" || kind === "school" || kind === "hospital") ? 0.22
    : 0.10;
  for (let row = 0; row < s.windowRows; row++) {
    for (let col = 0; col < s.windowCols; col++) {
      const padX = (cw * (1 - s.windowFill)) / 2;
      const padY = (rh * (1 - s.windowFill)) / 2;
      const x = col * cw + padX;
      const y = row * rh + padY;
      const ww = cw * s.windowFill;
      const wh = rh * s.windowFill;

      // Frame.
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.fillRect(x - 1, y - 1, ww + 2, wh + 2);

      // Glass.
      const lit = r() < litChance;
      g.fillStyle = lit ? s.windowLit : s.window;
      if (s.domeArch) {
        // Arched window top — half-circle on a rectangle.
        const archH = ww * 0.45;
        g.beginPath();
        g.moveTo(x, y + wh);
        g.lineTo(x, y + archH);
        g.arc(x + ww / 2, y + archH, ww / 2, Math.PI, 0, false);
        g.lineTo(x + ww, y + wh);
        g.closePath();
        g.fill();
      } else {
        g.fillRect(x, y, ww, wh);
      }

      // Vertical mullion + horizontal sill on each window.
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.fillRect(x + ww / 2 - 0.5, y, 1, wh);
      g.fillRect(x, y + wh / 2 - 0.5, ww, 1);
    }
  }

  // Floor slab lines between rows. Trim color overrides default if set.
  g.strokeStyle = s.trimColor ? hexToRGBA(s.trimColor, 0.55) : "rgba(0,0,0,0.18)";
  g.lineWidth = s.trimColor ? 2 : 1.5;
  for (let row = 1; row < s.windowRows; row++) {
    g.beginPath();
    g.moveTo(0, row * rh);
    g.lineTo(W, row * rh);
    g.stroke();
  }

  // Corrugated metal ribs — industrial / warehouse.
  if (s.metalRibs) {
    g.strokeStyle = "rgba(0,0,0,0.18)";
    g.lineWidth = 1;
    for (let x = 0; x < W; x += 8) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
    g.strokeStyle = "rgba(255,255,255,0.06)";
    for (let x = 4; x < W; x += 8) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
  }

  // Vertical rain streaks for weathering — adds realism, hides repetition.
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `rgba(0,0,0,${0.04 + r() * 0.05})`;
    const sx = r() * W;
    const sw = 1 + r() * 2;
    g.fillRect(sx, 0, sw, H);
  }

  const tex = new THREE.CanvasTexture(c);
  tuneTexture(tex);
  kindTexCache[kind] = tex;
  return tex;
}

// Highway: motorway/trunk/primary. Dark asphalt, white edge stripes,
// solid white centre line + dashed yellow lane divider.
export function highwayTexture(): THREE.CanvasTexture {
  if (roadTex) return roadTex;
  const W = 256, H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#262626";
  g.fillRect(0, 0, W, H);
  const r = rng(7);
  for (let i = 0; i < 8000; i++) {
    const v = 18 + r() * 50;
    g.fillStyle = `rgba(${v},${v},${v},${0.4 + r() * 0.5})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  // Long faint vertical scratches — wear from tires.
  g.strokeStyle = "rgba(0,0,0,0.18)";
  g.lineWidth = 1;
  for (let i = 0; i < 80; i++) {
    const x = r() * W;
    const y0 = r() * H * 0.6;
    const y1 = y0 + 30 + r() * 200;
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (r() - 0.5) * 4, y1); g.stroke();
  }
  // Tire-wear bands.
  g.fillStyle = "rgba(0,0,0,0.18)";
  g.fillRect(W * 0.18, 0, 10, H);
  g.fillRect(W * 0.82 - 10, 0, 10, H);
  // Edge stripes.
  g.fillStyle = "#e8e3d2";
  g.fillRect(3, 0, 5, H);
  g.fillRect(W - 8, 0, 5, H);
  // Yellow dashed centre.
  g.fillStyle = "#e8d96b";
  for (let y = 0; y < H; y += 192) g.fillRect(W / 2 - 4, y, 8, 96);
  roadTex = new THREE.CanvasTexture(c);
  tuneTexture(roadTex);
  return roadTex;
}

// Backwards-compat alias for callers still importing roadTexture.
export const roadTexture = highwayTexture;

let roadStdTex: THREE.CanvasTexture | null = null;
// Standard road: secondary/tertiary. Mid-grey asphalt, dashed white centre.
export function standardRoadTexture(): THREE.CanvasTexture {
  if (roadStdTex) return roadStdTex;
  const W = 256, H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a3a3a";
  g.fillRect(0, 0, W, H);
  const r = rng(8);
  for (let i = 0; i < 8000; i++) {
    const v = 32 + r() * 50;
    g.fillStyle = `rgba(${v},${v},${v},${0.4 + r() * 0.5})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  g.strokeStyle = "rgba(0,0,0,0.16)";
  g.lineWidth = 1;
  for (let i = 0; i < 60; i++) {
    const x = r() * W;
    const y0 = r() * H * 0.7;
    const y1 = y0 + 20 + r() * 180;
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (r() - 0.5) * 3, y1); g.stroke();
  }
  // Subtle edge wear.
  g.fillStyle = "rgba(0,0,0,0.12)";
  g.fillRect(W * 0.22, 0, 8, H);
  g.fillRect(W * 0.78 - 8, 0, 8, H);
  // Dashed white centre.
  g.fillStyle = "#dedbcf";
  for (let y = 0; y < H; y += 160) g.fillRect(W / 2 - 3, y, 6, 80);
  roadStdTex = new THREE.CanvasTexture(c);
  tuneTexture(roadStdTex);
  return roadStdTex;
}

let streetTex: THREE.CanvasTexture | null = null;
// Street: residential / unclassified. Lighter, no centre marking.
export function streetTexture(): THREE.CanvasTexture {
  if (streetTex) return streetTex;
  const W = 256, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4a4a48";
  g.fillRect(0, 0, W, H);
  const r = rng(9);
  for (let i = 0; i < 5000; i++) {
    const v = 50 + r() * 40;
    g.fillStyle = `rgba(${v},${v},${v - 4},${0.3 + r() * 0.4})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  streetTex = new THREE.CanvasTexture(c);
  tuneTexture(streetTex);
  return streetTex;
}

let serviceTex: THREE.CanvasTexture | null = null;
// Service / track: gravel-ish beige.
export function serviceTexture(): THREE.CanvasTexture {
  if (serviceTex) return serviceTex;
  const W = 256, H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#8c8273";
  g.fillRect(0, 0, W, H);
  const r = rng(10);
  for (let i = 0; i < 6000; i++) {
    const v = 110 + r() * 60;
    g.fillStyle = `rgba(${v},${v - 8},${v - 24},${0.3 + r() * 0.4})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  serviceTex = new THREE.CanvasTexture(c);
  tuneTexture(serviceTex);
  return serviceTex;
}

export function bikeTexture(): THREE.CanvasTexture {
  if (bikeTex) return bikeTex;
  const W = 128, H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // Asphalt-red base with grain.
  g.fillStyle = "#7a1c1c";
  g.fillRect(0, 0, W, H);
  const r = rng(11);
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.18})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  // Lane edge stripes.
  g.fillStyle = "#ffffff";
  g.fillRect(4, 0, 3, H);
  g.fillRect(W - 7, 0, 3, H);

  // Direction chevron — a clean white arrow points "down" the lane (toward
  // texture +V), much easier to read than the previous wheel circles.
  g.strokeStyle = "#ffffff";
  g.lineWidth = 5;
  g.lineJoin = "round";
  g.lineCap = "round";
  const cx = W / 2;
  const baseY = H * 0.45;
  const tipY = H * 0.62;
  const wing = W * 0.22;
  g.beginPath();
  g.moveTo(cx - wing, baseY);
  g.lineTo(cx, tipY);
  g.lineTo(cx + wing, baseY);
  g.stroke();

  // Small bike pictogram in the lower half. Two wheels + triangle frame.
  g.strokeStyle = "#ffffff";
  g.lineWidth = 2.5;
  const wy = H * 0.86;
  const wr = 9;
  const sep = 22;
  g.beginPath();
  g.arc(cx - sep, wy, wr, 0, Math.PI * 2);
  g.arc(cx + sep, wy, wr, 0, Math.PI * 2);
  g.stroke();
  // Frame: rear hub → seat tube top → front hub.
  g.beginPath();
  g.moveTo(cx - sep, wy);
  g.lineTo(cx - 2, wy - 16);
  g.lineTo(cx + sep, wy);
  g.stroke();
  // Down tube + handlebar stem.
  g.beginPath();
  g.moveTo(cx - sep, wy);
  g.lineTo(cx + 6, wy - 18);
  g.stroke();
  g.beginPath();
  g.moveTo(cx + 6, wy - 18);
  g.lineTo(cx + 12, wy - 22);
  g.stroke();

  bikeTex = new THREE.CanvasTexture(c);
  tuneTexture(bikeTex);
  return bikeTex;
}

export function busTexture(): THREE.CanvasTexture {
  if (busTex) return busTex;
  const W = 128, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#a82929";
  g.fillRect(0, 0, W, H);
  const r = rng(13);
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.22})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  g.fillStyle = "#ffffff";
  g.font = "bold 36px sans-serif";
  g.textAlign = "center";
  g.fillText("BUS", W / 2, 260);
  busTex = new THREE.CanvasTexture(c);
  tuneTexture(busTex);
  return busTex;
}

export function tramTexture(): THREE.CanvasTexture {
  if (tramTex) return tramTex;
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a3530";
  g.fillRect(0, 0, W, H);
  // Two parallel rails.
  g.fillStyle = "#aaaaaa";
  g.fillRect(W * 0.28, 0, 6, H);
  g.fillRect(W * 0.68, 0, 6, H);
  // Rail highlights.
  g.fillStyle = "#dadada";
  g.fillRect(W * 0.28 + 1, 0, 1, H);
  g.fillRect(W * 0.68 + 1, 0, 1, H);
  // Crossties.
  g.fillStyle = "#241f1a";
  for (let y = 0; y < H; y += 24) {
    g.fillRect(W * 0.18, y, W * 0.62, 6);
  }
  tramTex = new THREE.CanvasTexture(c);
  tuneTexture(tramTex);
  return tramTex;
}

export function footwayTexture(): THREE.CanvasTexture {
  if (footwayTex) return footwayTex;
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#b9b3a8";
  g.fillRect(0, 0, W, H);
  // Per-paver subtle colour variation.
  const r = rng(17);
  const PCols = 4, PRows = 4;
  const pcw = W / PCols, prh = H / PRows;
  for (let row = 0; row < PRows; row++) {
    for (let col = 0; col < PCols; col++) {
      const tone = 175 + Math.floor(r() * 25);
      g.fillStyle = `rgb(${tone},${tone - 5},${tone - 14})`;
      g.fillRect(col * pcw + 1, row * prh + 1, pcw - 2, prh - 2);
    }
  }
  // Grout grid.
  g.strokeStyle = "rgba(0,0,0,0.32)";
  g.lineWidth = 1.5;
  for (let i = 0; i <= PCols; i++) {
    g.beginPath();
    g.moveTo((i * W) / PCols, 0);
    g.lineTo((i * W) / PCols, H);
    g.stroke();
  }
  for (let i = 0; i <= PRows; i++) {
    g.beginPath();
    g.moveTo(0, (i * H) / PRows);
    g.lineTo(W, (i * H) / PRows);
    g.stroke();
  }
  footwayTex = new THREE.CanvasTexture(c);
  tuneTexture(footwayTex);
  return footwayTex;
}

export function waterTexture(): THREE.CanvasTexture {
  if (waterTex) return waterTex;
  const W = 512, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // Multi-stop deep-water gradient.
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#0e3962");
  grad.addColorStop(0.3, "#1a5b94");
  grad.addColorStop(0.55, "#2674b1");
  grad.addColorStop(0.8, "#1a5b94");
  grad.addColorStop(1, "#0e3962");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Layered sinusoid wave crests at three frequencies for organic-looking
  // ripples without a heavy shader.
  const waveBands: Array<{ freq: number; amp: number; rows: number; alpha: number; phase: number }> = [
    { freq: 0.06, amp: 5, rows: 22, alpha: 0.18, phase: 0 },
    { freq: 0.14, amp: 3, rows: 30, alpha: 0.10, phase: 1.7 },
    { freq: 0.27, amp: 2, rows: 38, alpha: 0.07, phase: 3.4 },
  ];
  for (const band of waveBands) {
    g.strokeStyle = `rgba(255,255,255,${band.alpha})`;
    g.lineWidth = 1.5;
    for (let i = 0; i < band.rows; i++) {
      g.beginPath();
      const y = (i * H) / band.rows + (i % 2) * 4;
      g.moveTo(0, y);
      for (let x = 0; x <= W; x += 6) {
        g.lineTo(x, y + Math.sin(x * band.freq + i + band.phase) * band.amp);
      }
      g.stroke();
    }
  }
  // Fine speckle for sun glints.
  const r = rng(31);
  for (let i = 0; i < 1200; i++) {
    g.fillStyle = `rgba(255,255,255,${0.05 + r() * 0.08})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  waterTex = new THREE.CanvasTexture(c);
  tuneTexture(waterTex);
  return waterTex;
}

export function groundTexture(): THREE.CanvasTexture {
  if (groundTex) return groundTex;
  const W = 512, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4f7a3a";
  g.fillRect(0, 0, W, H);
  const r = rng(23);
  // Multi-tone speckle for grass blades.
  for (let i = 0; i < 12000; i++) {
    const rr = 60 + r() * 50;
    const gg = 100 + r() * 70;
    const bb = 40 + r() * 30;
    g.fillStyle = `rgba(${rr},${gg},${bb},${0.4 + r() * 0.5})`;
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  // Darker patches for clumps.
  for (let i = 0; i < 80; i++) {
    g.fillStyle = `rgba(40,70,30,${0.1 + r() * 0.2})`;
    const cx = r() * W, cy = r() * H;
    const rr = 6 + r() * 14;
    g.beginPath();
    g.arc(cx, cy, rr, 0, Math.PI * 2);
    g.fill();
  }
  groundTex = new THREE.CanvasTexture(c);
  tuneTexture(groundTex);
  groundTex.repeat.set(200, 200);
  return groundTex;
}
