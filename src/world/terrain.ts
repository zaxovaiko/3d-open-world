import * as THREE from "three";

// Cheap deterministic 2D value noise. Good enough for distant hills/mountains.
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function smooth(t: number) {
  return t * t * (3 - 2 * t);
}
function noise2(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  const u = smooth(xf);
  const v = smooth(zf);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, u),
    THREE.MathUtils.lerp(c, d, u),
    v,
  );
}
function fbm(x: number, z: number, octaves = 4): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, z * freq);
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / max;
}

const FLAT_RADIUS = 350; // car drives in a flat zone; physics stays simple.
const RAMP_RADIUS = 1200; // hills fully rise here.
const MAX_HEIGHT = 220; // peak hill height.
const NOISE_SCALE = 1 / 600;

export function elevationAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= FLAT_RADIUS) return 0;
  const ramp = THREE.MathUtils.smoothstep(r, FLAT_RADIUS, RAMP_RADIUS);
  // Two layers of fbm for hill + mountain detail.
  const base = fbm(x * NOISE_SCALE, z * NOISE_SCALE, 4);
  const ridge = Math.pow(Math.abs(0.5 - fbm(x * NOISE_SCALE * 2.3, z * NOISE_SCALE * 2.3, 3)), 1.4);
  const h = base * 0.7 + (1 - ridge) * 0.5;
  return h * ramp * MAX_HEIGHT;
}

export function buildTerrainGeometry(size: number, segments: number): THREE.BufferGeometry {
  const half = size / 2;
  const step = size / segments;
  const verts = (segments + 1) * (segments + 1);
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  let p = 0;
  let u = 0;
  for (let j = 0; j <= segments; j++) {
    for (let i = 0; i <= segments; i++) {
      const x = -half + i * step;
      const z = -half + j * step;
      const y = elevationAt(x, z);
      positions[p++] = x;
      positions[p++] = y;
      positions[p++] = z;
      uvs[u++] = i / segments;
      uvs[u++] = j / segments;
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let k = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i;
      const b = a + 1;
      const c = a + (segments + 1);
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
