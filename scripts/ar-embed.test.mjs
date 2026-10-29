import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const snippets = [
  ['embed/legacy-side-snippet.html', 'legacy-side'],
  ['embed/legacy-arm-snippet.html', 'legacy-arm'],
  ['embed/windsor-side-snippet.html', 'windsor-side'],
  ['embed/windsor-arm-snippet.html', 'windsor-arm'],
  ['embed/traditional-turned-snippet.html', 'traditional-turned'],
  ['embed/traditional-straight-snippet.html', 'traditional-straight'],
  ['embed/traditional-stool-snippet.html', 'traditional-stool'],
  ['embed/model-viewer-snippet.html', 'windsor'],
];

for (const [file, slug] of snippets) {
  test(`${file} points View in your room at the v4 USDZ`, async () => {
    const html = await readFile(file, 'utf8');
    const base = `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v4/models/${slug}/${slug}`;
    assert.match(html, /model-viewer\/4\.3\.1\/model-viewer\.min\.js/);
    assert.match(html, /\n\s+ar\n/);
    assert.match(html, /ar-modes="scene-viewer webxr quick-look"/);
    assert.match(html, /ar-scale="fixed"/);
    assert.match(html, /ar-placement="floor"/);
    assert.match(html, new RegExp(`src="${base}\\.glb"`));
    assert.match(html, new RegExp(`ios-src="${base}\\.usdz"`));
    assert.match(html, new RegExp(`poster="${base.replace(`${slug}/${slug}`, `${slug}/poster`)}\\.webp"`));
    assert.match(html, /<button slot="ar-button" type="button" class="artesao-ar">View in your room<\/button>/);
    assert.equal(html.includes('@v2'), false);
    assert.equal(html.includes('@v3'), false);
    assert.equal(html.includes('<script'), true);
    assert.equal(html.includes('type="module"'), true);
  });
}

test('the demo page sets the same AR attributes and a relative USDZ', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.match(html, /model-viewer\/4\.3\.1\/model-viewer\.min\.js/);
  assert.match(html, /ar-modes', 'webxr scene-viewer quick-look'/);
  assert.match(html, /ar-scale', 'fixed'/);
  assert.match(html, /ar-placement', 'floor'/);
  assert.match(html, /ios-src', usdz/);
  assert.match(html, /View in your room/);
  assert.match(html, /artesao-3d-models@v3/);
  assert.equal(html.includes('@v2'), false);
});
