import { CHUNK_BYTES, MAX_FILE_BYTES } from './limits.js';

const PASSWORD_KEY = 'artesao-project-viewer-password';
const UNIT_NAMES = {
  m: 'meters',
  cm: 'centimeters',
  mm: 'millimeters',
  in: 'inches',
  ft: 'feet',
};

export function shareUrl(origin, token) {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  return new URL(`view/${encodeURIComponent(token)}`, base).href;
}

export function formatSize(size) {
  if (!size) return '';
  const cm = (value) => (Number(value) * 100).toFixed(1);
  return `${cm(size.x)} cm wide × ${cm(size.z)} cm deep × ${cm(size.y)} cm tall`;
}

if (typeof document !== 'undefined') {
const gate = document.getElementById('gate');
const gateForm = document.getElementById('gate-form');
const gateError = document.getElementById('gate-error');
const passwordInput = document.getElementById('password');
const workspace = document.getElementById('workspace');
const lockButton = document.getElementById('lock');
const fileInput = document.getElementById('file');
const drop = document.getElementById('drop');
const stage = document.getElementById('stage');
const canvas = document.getElementById('preview');
const unitsInput = document.getElementById('units');
const upInput = document.getElementById('up');
const nameInput = document.getElementById('name');
const statusEl = document.getElementById('status');
const warnEl = document.getElementById('warn');
const saveButton = document.getElementById('save');
const result = document.getElementById('result');
const shareInput = document.getElementById('share');
const copyButton = document.getElementById('copy');
const openLink = document.getElementById('open');
const list = document.getElementById('list');
const empty = document.getElementById('empty');

let password = '';
let fbxBuffer = null;
let converted = null;
let busy = false;
let preview = null;

function passwordHeader(value) {
  return encodeURIComponent(value);
}

function authHeaders(extra = {}) {
  return { 'X-Admin-Password': passwordHeader(password), ...extra };
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    return body.message || 'That did not work.';
  } catch {
    return 'That did not work.';
  }
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setWarn(text) {
  warnEl.textContent = text;
}

function unitSentence(result) {
  const name = UNIT_NAMES[result.units] || result.units;
  if (result.unitSource === 'file') return `The FBX says these numbers are ${name}.`;
  if (result.unitSource === 'chosen') return `Using ${name}.`;
  const longest = Number(result.longest).toFixed(1);
  return `The file does not say which units it uses. The longest side is ${longest}, so this is treated as ${name}.`;
}

async function unlock(nextPassword) {
  password = nextPassword;
  const response = await fetch('/api/admin/projects', { headers: authHeaders() });
  if (!response.ok) {
    password = '';
    sessionStorage.removeItem(PASSWORD_KEY);
    throw new Error(await errorMessage(response));
  }
  sessionStorage.setItem(PASSWORD_KEY, nextPassword);
  const body = await response.json();
  gate.hidden = true;
  workspace.hidden = false;
  lockButton.hidden = false;
  gateError.textContent = '';
  renderList(body.projects || []);
}

function lock() {
  password = '';
  sessionStorage.removeItem(PASSWORD_KEY);
  workspace.hidden = true;
  lockButton.hidden = true;
  gate.hidden = false;
  passwordInput.value = '';
  result.hidden = true;
}

async function refreshList() {
  const response = await fetch('/api/admin/projects', { headers: authHeaders() });
  if (response.status === 401 || response.status === 503) {
    lock();
    gateError.textContent = await errorMessage(response);
    return;
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = await response.json();
  renderList(body.projects || []);
}

function renderList(projects) {
  list.replaceChildren();
  empty.hidden = projects.length !== 0;
  for (const project of projects) {
    const item = document.createElement('li');
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 120;
    name.value = project.name;
    name.setAttribute('aria-label', 'Project or client');
    const saveName = document.createElement('button');
    saveName.type = 'button';
    saveName.textContent = 'Save name';
    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    nameRow.append(name, saveName);

    const meta = document.createElement('p');
    meta.className = 'meta';
    const bits = [formatWhen(project.createdAt)];
    if (project.status === 'ready' && project.sizeMeters) bits.push(formatSize(project.sizeMeters));
    if (project.status !== 'ready') bits.push('Not finished');
    meta.textContent = bits.filter(Boolean).join(' · ');

    const url = shareUrl(location.origin, project.token);
    const link = document.createElement('input');
    link.type = 'text';
    link.readOnly = true;
    link.value = url;
    link.setAttribute('aria-label', `Link for ${project.name}`);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    const linkRow = document.createElement('div');
    linkRow.className = 'linkrow';
    linkRow.append(link, copy, remove);

    copy.addEventListener('click', () => copyText(url, copy));
    saveName.addEventListener('click', async () => {
      saveName.disabled = true;
      try {
        const response = await fetch(`/api/admin/projects/${encodeURIComponent(project.token)}`, {
          method: 'PATCH',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ name: name.value }),
        });
        if (!response.ok) throw new Error(await errorMessage(response));
        if (shareInput.dataset.token === project.token) {
          const saved = await response.json();
          name.value = saved.name;
        }
        await refreshList();
      } catch (err) {
        meta.textContent = err.message;
      } finally {
        saveName.disabled = false;
      }
    });
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${name.value}”? The link will stop working.`)) return;
      remove.disabled = true;
      const response = await fetch(`/api/admin/projects/${encodeURIComponent(project.token)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!response.ok) {
        meta.textContent = await errorMessage(response);
        remove.disabled = false;
        return;
      }
      if (shareInput.dataset.token === project.token) result.hidden = true;
      await refreshList();
    });

    item.append(nameRow, meta, linkRow);
    list.append(item);
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const previous = button.textContent;
  button.textContent = 'Copied';
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1600);
}

async function showPreview(object) {
  const THREE = await import('three');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  stage.hidden = false;
  if (!preview) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 0.4, 0);
    scene.add(new THREE.HemisphereLight(0xfff6ea, 0xc9bfb2, 1));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe7eef8, 0.4);
    fill.position.set(-4, 2, -2);
    scene.add(fill);
    const grid = new THREE.GridHelper(4, 8, 0xd5c7b8, 0xe6ddd3);
    scene.add(grid);
    preview = { THREE, renderer, scene, camera, controls, furniture: null, grid };
    const draw = () => {
      preview.controls.update();
      preview.renderer.render(preview.scene, preview.camera);
      preview.frame = requestAnimationFrame(draw);
    };
    draw();
    const resize = () => {
      const width = canvas.clientWidth || 640;
      const height = canvas.clientHeight || 420;
      preview.renderer.setSize(width, height, false);
      preview.camera.aspect = width / height;
      preview.camera.updateProjectionMatrix();
    };
    resize();
    new ResizeObserver(resize).observe(stage);
  }
  if (preview.furniture) preview.scene.remove(preview.furniture);
  preview.furniture = object;
  preview.scene.add(object);
  const box = new preview.THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new preview.THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);
  preview.controls.target.copy(sphere.center);
  const distance = radius / Math.sin(preview.THREE.MathUtils.degToRad(15));
  preview.camera.position.set(
    sphere.center.x + radius,
    sphere.center.y + radius * 0.65,
    sphere.center.z + distance * 0.55,
  );
  preview.camera.near = Math.max(radius / 100, 0.001);
  preview.camera.far = Math.max(radius * 40, 10);
  preview.camera.updateProjectionMatrix();
  const gridSize = preview.THREE.MathUtils.clamp(radius * 6, 1, 20);
  preview.grid.scale.setScalar(gridSize / 4);
  preview.controls.update();
}

async function convertCurrent() {
  if (!fbxBuffer || busy) return;
  saveButton.disabled = true;
  converted = null;
  setWarn('');
  setStatus('Reading the FBX…');
  try {
    const { convertFbx } = await import('./convert.mjs');
    setStatus('Scaling it to meters…');
    const result = await convertFbx(fbxBuffer, {
      units: unitsInput.value,
      up: upInput.value,
    });
    converted = result;
    const heightCm = result.sizeMeters.y * 100;
    const longestCm = Math.max(result.sizeMeters.x, result.sizeMeters.y, result.sizeMeters.z) * 100;
    setStatus(`${unitSentence(result)} ${formatSize(result.sizeMeters)}.`);
    if (heightCm < 15 || heightCm > 800 || longestCm > 800) {
      setWarn('That size looks unusual for a single piece of furniture. Try another unit, or export only the piece and not the room.');
    }
    if (result.glb.byteLength > MAX_FILE_BYTES || result.usdz.byteLength > MAX_FILE_BYTES) {
      setWarn('The converted model is over 18 MB, which is too large to store. Export a simpler FBX.');
      converted = null;
      return;
    }
    try {
      await showPreview(result.object);
    } catch (err) {
      setWarn(`The preview could not be drawn (${err.message}). You can still create the link.`);
    }
    saveButton.disabled = false;
  } catch (err) {
    setStatus('');
    setWarn(err.message || 'This FBX could not be read.');
  }
}

async function onFile(file) {
  if (!file) return;
  const name = file.name || 'model.fbx';
  if (!name.toLowerCase().endsWith('.fbx')) {
    setWarn('Choose an FBX file.');
    return;
  }
  if (file.size > 40 * 1024 * 1024) {
    setWarn('That FBX is over 40 MB. Export the piece on its own, without the room.');
    return;
  }
  if (!nameInput.value) nameInput.value = name.replace(/\.fbx$/i, '').replace(/[_-]+/g, ' ');
  setWarn('');
  fbxBuffer = await file.arrayBuffer();
  await convertCurrent();
}

async function putFile(token, kind, buffer) {
  const bytes = new Uint8Array(buffer);
  const total = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  for (let index = 0; index < total; index += 1) {
    const slice = bytes.subarray(index * CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * CHUNK_BYTES));
    setStatus(`Uploading the ${kind.toUpperCase()}, part ${index + 1} of ${total}…`);
    const response = await fetch(`/api/admin/projects/${encodeURIComponent(token)}/chunks/${kind}/${index}`, {
      method: 'PUT',
      headers: authHeaders({
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Total': String(total),
      }),
      body: slice,
    });
    if (!response.ok) throw new Error(await errorMessage(response));
  }
  return total;
}

async function saveProject() {
  if (!converted || busy) return;
  busy = true;
  saveButton.disabled = true;
  setWarn('');
  try {
    setStatus('Creating the project…');
    const created = await fetch('/api/admin/projects', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: nameInput.value }),
    });
    if (!created.ok) throw new Error(await errorMessage(created));
    const { token } = await created.json();
    const glbChunks = await putFile(token, 'glb', converted.glb);
    const usdzChunks = await putFile(token, 'usdz', converted.usdz);
    setStatus('Finishing…');
    const done = await fetch(`/api/admin/projects/${encodeURIComponent(token)}/complete`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: nameInput.value,
        units: converted.units,
        sizeMeters: converted.sizeMeters,
        glbChunks,
        usdzChunks,
      }),
    });
    if (!done.ok) throw new Error(await errorMessage(done));
    const project = await done.json();
    const url = shareUrl(location.origin, project.token);
    shareInput.value = url;
    shareInput.dataset.token = project.token;
    openLink.href = url;
    result.hidden = false;
    setStatus('The link is ready.');
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await refreshList();
  } catch (err) {
    setStatus('');
    setWarn(err.message || 'The upload did not finish.');
    await refreshList().catch(() => {});
  } finally {
    busy = false;
    saveButton.disabled = !converted;
  }
}

gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  gateError.textContent = '';
  try {
    await unlock(passwordInput.value);
  } catch (err) {
    gateError.textContent = err.message;
  }
});

lockButton.addEventListener('click', lock);
fileInput.addEventListener('change', () => onFile(fileInput.files[0]));
drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  onFile(event.dataTransfer.files[0]);
});
unitsInput.addEventListener('change', () => convertCurrent());
upInput.addEventListener('change', () => convertCurrent());
saveButton.addEventListener('click', () => saveProject());
copyButton.addEventListener('click', () => copyText(shareInput.value, copyButton));

const saved = sessionStorage.getItem(PASSWORD_KEY);
if (saved) {
  passwordInput.value = saved;
  unlock(saved).catch((err) => {
    gateError.textContent = err.message;
  });
}
}
