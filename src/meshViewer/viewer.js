// The 3D viewer behind a dropped mesh: a DeckWerk web element page showing one
// or more models side by side. Models arrive inlined as data: URIs in
// window.MODELS = [{ url, kind: "glb"|"obj", color? }] (see src/main/meshPage.ts);
// with a colour every mesh is painted in one matte clay. One drag rotates every
// view together; idle, they turn slowly. Built by vite.meshviewer.config.ts.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const models = window.MODELS;
// Without WebGL (a GPU-less capture, an old projector laptop) show a still instead of nothing.
function fallback() {
  if (!window.FALLBACK) return;
  const img = document.createElement('img');
  img.src = window.FALLBACK;
  img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
  document.body.replaceChildren(img);
}
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
} catch (error) {
  fallback();
  throw error;
}
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
camera.position.set(2.0, 1.3, 2.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;
controls.minDistance = 1.2;
controls.maxDistance = 8;
// The first touch stops the idle turn; it does not come back until the slide is shown again.
controls.addEventListener('start', () => { controls.autoRotate = false; });

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b4aa, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8);
  rim.position.set(-4, 2, -3);
  scene.add(rim);
}

// Each model is centred and scaled to the same bounding sphere, so different sources
// line up and a long leg never turns out of the frame.
function normalise(object) {
  const box = new THREE.Box3().setFromObject(object);
  const centre = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const scale = 0.95 / sphere.radius;
  object.position.sub(centre).multiplyScalar(scale);
  object.scale.setScalar(scale);
  const holder = new THREE.Group();
  holder.add(object);
  return holder;
}

const clay = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
const views = models.map(() => {
  const scene = new THREE.Scene();
  lights(scene);
  return { scene };
});

await Promise.all(models.map(async (model, i) => {
  let object;
  if (model.kind === 'obj') {
    const text = await (await fetch(model.url)).text();
    object = new OBJLoader().parse(text);
    if (!model.color) model.color = '#b8bfd9';
  } else {
    const buffer = await (await fetch(model.url)).arrayBuffer();
    // Meshes come meshopt-compressed: its decoder is inline, so nothing is fetched while presenting.
    object = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '')).scene;
  }
  const paint = model.color ? clay(model.color) : null;
  object.traverse((node) => {
    if (!node.isMesh) return;
    if (!node.geometry.attributes.normal) node.geometry.computeVertexNormals();
    if (paint) node.material = paint;
    else for (const m of [].concat(node.material)) m.side = THREE.DoubleSide;
  });
  views[i].scene.add(normalise(object));
}));

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = (w / views.length) / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function frame() {
  controls.update();
  const w = window.innerWidth, h = window.innerHeight, cell = w / views.length;
  renderer.setClearColor(0x000000, 0);
  views.forEach((view, i) => {
    renderer.setViewport(i * cell, 0, cell, h);
    renderer.setScissor(i * cell, 0, cell, h);
    renderer.render(view.scene, camera);
  });
  requestAnimationFrame(frame);
}
frame();
document.body.dataset.ready = "1";

if (window.deckwerk) {
  window.deckwerk.onActive(() => {
    controls.autoRotate = true;
    camera.position.set(2.0, 1.3, 2.4);
    controls.target.set(0, 0, 0);
  });
}
