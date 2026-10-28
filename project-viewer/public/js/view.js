const TOKEN = /^[A-Za-z0-9_-]{22}$/;

export function tokenFromPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'view' || !TOKEN.test(parts[1])) return null;
  return parts[1];
}

export function modelUrls(origin, token) {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  return {
    glb: new URL(`m/${encodeURIComponent(token)}/model.glb`, base).href,
    usdz: new URL(`m/${encodeURIComponent(token)}/model.usdz`, base).href,
  };
}

export function formatSize(size) {
  if (!size) return '';
  const cm = (value) => (Number(value) * 100).toFixed(1);
  if (![size.x, size.y, size.z].every((value) => Number.isFinite(Number(value)))) return '';
  return `${cm(size.x)} cm wide × ${cm(size.z)} cm deep × ${cm(size.y)} cm tall`;
}

async function boot() {
  const missing = document.getElementById('missing');
  const stage = document.getElementById('stage');
  const nameEl = document.getElementById('name');
  const sizeEl = document.getElementById('size');
  const viewer = document.getElementById('viewer');
  const token = tokenFromPath(location.pathname);
  const showMissing = () => {
    missing.hidden = false;
    stage.hidden = true;
    nameEl.hidden = true;
    sizeEl.hidden = true;
    document.title = 'Not available · Artesão';
  };
  if (!token) {
    showMissing();
    return;
  }
  let meta = null;
  try {
    const response = await fetch(`/api/view/${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' },
    });
    if (response.ok) meta = await response.json();
  } catch {
    meta = null;
  }
  if (!meta || typeof meta.name !== 'string') {
    showMissing();
    return;
  }
  const urls = modelUrls(location.origin, token);
  viewer.setAttribute('src', urls.glb);
  viewer.setAttribute('ios-src', urls.usdz);
  viewer.setAttribute('alt', meta.name === 'Untitled project' ? '3D model' : `3D model of ${meta.name}`);
  nameEl.textContent = meta.name;
  nameEl.hidden = false;
  const size = formatSize(meta.sizeMeters);
  if (size) {
    sizeEl.textContent = size;
    sizeEl.hidden = false;
  }
  stage.hidden = false;
  document.title = `${meta.name} · Artesão`;
}

if (typeof document !== 'undefined') boot();
