// Visor y generador de miniaturas para archivos STL (Three.js)
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const loader = new STLLoader();
const geometryCache = new Map();

export function loadGeometry(url) {
  if (!geometryCache.has(url)) {
    geometryCache.set(url, new Promise((resolve, reject) => {
      loader.load(url, geo => resolve(prepare(geo)), undefined, reject);
    }));
  }
  return geometryCache.get(url);
}

export function parseGeometry(arrayBuffer) {
  return prepare(loader.parse(arrayBuffer));
}

// Centra la pieza, la apoya en el "piso" y la gira (los STL suelen venir con Z hacia arriba)
function prepare(geo) {
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geo.translate(-center.x, -box.min.y, -center.z);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function buildScene(geo, color) {
  const scene = new THREE.Scene();

  scene.add(new THREE.HemisphereLight(0xdfe4ff, 0x1a1d33, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 2, 1.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x22d3ee, 0.8);
  rim.position.set(-2, 1, -1.5);
  scene.add(rim);

  const material = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.45 });
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const radius = geo.boundingSphere.radius || 1;

  const grid = new THREE.GridHelper(radius * 4, 20, 0x3b4170, 0x262b4d);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  scene.add(grid);

  return { scene, mesh, radius, height: size.y };
}

function frameCamera(camera, radius, height) {
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.position.set(dist * 0.7, height * 0.5 + dist * 0.45, dist * 0.7);
  camera.updateProjectionMatrix();
  return new THREE.Vector3(0, height / 2, 0);
}

// ---------- Miniaturas: un único renderer compartido ----------
let thumbRenderer = null;
let queue = Promise.resolve();

export function thumbnail(url, { width = 480, height = 360, color = 0x8b7bff } = {}) {
  const job = queue.then(async () => {
    const geo = await loadGeometry(url);
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      thumbRenderer.setPixelRatio(1);
    }
    thumbRenderer.setSize(width, height, false);
    const { scene, radius, height: h } = buildScene(geo, color);
    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 1000);
    const target = frameCamera(camera, radius, h);
    camera.lookAt(target);
    thumbRenderer.render(scene, camera);
    const data = thumbRenderer.domElement.toDataURL('image/png');
    scene.traverse(o => o.material && o.material.dispose());
    return data;
  });
  queue = job.catch(() => {});
  return job;
}

// ---------- Visor interactivo ----------
export function createViewer(container, { color = 0x8b7bff, autoRotate = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = 2;

  let scene = new THREE.Scene();
  let raf = null;

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function loop() {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  function show(geo) {
    scene.traverse(o => o.material && o.material.dispose());
    const built = buildScene(geo, color);
    scene = built.scene;
    const target = frameCamera(camera, built.radius, built.height);
    controls.target.copy(target);
    controls.minDistance = built.radius * 0.5;
    controls.maxDistance = built.radius * 8;
    controls.update();
    if (!raf) loop();
  }

  return {
    async load(url) { show(await loadGeometry(url)); },
    showGeometry: show,
    dispose() {
      cancelAnimationFrame(raf);
      raf = null;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    }
  };
}
