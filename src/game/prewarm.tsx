import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { BUILDING_MAT, ROAD_MAT } from "./world-meshes";

// Pre-link shaders + upload textures at Scene mount. Without this, the first
// new tile that uses each material triggers GLSL compile + first GPU texture
// upload on the render thread, costing 30-80ms per material.
//
// Strategy: build a hidden THREE.Scene with one tiny mesh per material, call
// gl.compile(scene, camera). compile() walks materials, links programs, and
// initializes textures without rendering pixels.
export function Prewarm() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const tempScene = new THREE.Scene();
    // Single triangle. Position + uv + normal so every shader path resolves.
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    geom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));

    const meshes: THREE.Mesh[] = [];
    for (const k of Object.keys(BUILDING_MAT) as Array<keyof typeof BUILDING_MAT>) {
      meshes.push(new THREE.Mesh(geom, BUILDING_MAT[k]));
    }
    for (const k of Object.keys(ROAD_MAT) as Array<keyof typeof ROAD_MAT>) {
      meshes.push(new THREE.Mesh(geom, ROAD_MAT[k]));
    }
    for (const m of meshes) tempScene.add(m);

    gl.compile(tempScene, camera);

    // Materials + textures are global singletons; only dispose the temp
    // geometry and detach meshes.
    for (const m of meshes) tempScene.remove(m);
    geom.dispose();
  }, [gl, camera]);

  return null;
}
