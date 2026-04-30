import * as THREE from "three";

export function elevationAt(_x: number, _z: number): number {
  return 0;
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
      positions[p++] = x;
      positions[p++] = 0;
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
