# Artesão 3D models

These are the 3D furniture files for [artesao.co](https://artesao.co). Each product lives in its own folder under `models/`. The site shows them with Google's [`@google/model-viewer`](https://www.npmjs.com/package/@google/model-viewer) web component, pinned to **v4.3.1**.

The files are public on purpose, so the viewer on Squarespace (and on a later site, if the shop moves) can load them. Two addresses serve the same files:

| | Address |
|---|---|
| GitHub Pages | `https://artesaofinefurniture.github.io/artesao-3d-models/models/<product>/<product>.glb` |
| jsDelivr (versioned) | `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@<tag>/models/<product>/<product>.glb` |

jsDelivr is the address to paste into the website. A tag such as `v1` stays put when later products are added. GitHub Pages hosts the [demo page](https://artesaofinefurniture.github.io/artesao-3d-models/) that lists every model.

Commit the `.glb` and poster as normal Git files. Do not turn on Git LFS. LFS stores a small pointer text file instead of the model, and both GitHub Pages and jsDelivr would serve that pointer, so the viewer would fail. Keep each file under **20 MB** (jsDelivr's limit for a GitHub file). GitHub itself accepts files up to 100 MB.

## Windsor dining chairs

Side chair and armchair, converted from the Fusion OBJ exports in `source/`. The frame is a grey-brown walnut with a photographic grain. The seat and back are a soft matte light warm-grey leather. Finished height is 96.8 cm. Each model is about 324 KB.

| | Side chair | Armchair |
|---|---|---|
| Folder | `models/windsor/` | `models/windsor-arm/` |
| Finished size | 53.7 × 51.3 × 96.8 cm | 56.1 × 52.9 × 96.8 cm |
| Squarespace block | [`embed/model-viewer-snippet.html`](embed/model-viewer-snippet.html) | [`embed/windsor-arm-snippet.html`](embed/windsor-arm-snippet.html) |

**jsDelivr**, after you publish the `v1` release described below

- Side model: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/windsor/windsor.glb`
- Side poster: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/windsor/poster.webp`
- Arm model: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/windsor-arm/windsor-arm.glb`
- Arm poster: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/windsor-arm/poster.webp`

**GitHub Pages**, after Pages is turned on

- Side model: `https://artesaofinefurniture.github.io/artesao-3d-models/models/windsor/windsor.glb`
- Arm model: `https://artesaofinefurniture.github.io/artesao-3d-models/models/windsor-arm/windsor-arm.glb`

Until that release exists, `@main` serves whatever is on the main branch (jsDelivr may cache it for a while, so use it only to test):

`https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@main/models/windsor/windsor.glb`

## Traditional dining chairs

Two versions of the Traditional chair, converted from the Fusion OBJ exports in `source/`. Finished height is about 95 cm.

| | Turned leg | Straight leg |
|---|---|---|
| Real wood | Walnut | Figured maple |
| Folder | `models/traditional-turned/` | `models/traditional-straight/` |
| Finished size | 48.3 × 52.4 × 95.5 cm | 47.2 × 54.9 × 94.7 cm |
| Squarespace block | [`embed/traditional-turned-snippet.html`](embed/traditional-turned-snippet.html) | [`embed/traditional-straight-snippet.html`](embed/traditional-straight-snippet.html) |

**jsDelivr**, after the `v1` release

- Turned model: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/traditional-turned/traditional-turned.glb`
- Turned poster: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/traditional-turned/poster.webp`
- Straight model: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/traditional-straight/traditional-straight.glb`
- Straight poster: `https://cdn.jsdelivr.net/gh/ArtesaoFineFurniture/artesao-3d-models@v1/models/traditional-straight/poster.webp`

**GitHub Pages**, after Pages is turned on

- Turned model: `https://artesaofinefurniture.github.io/artesao-3d-models/models/traditional-turned/traditional-turned.glb`
- Straight model: `https://artesaofinefurniture.github.io/artesao-3d-models/models/traditional-straight/traditional-straight.glb`

Paste a snippet the same way as Windsor, below. Each file is already filled in. Two blocks on one page are fine.

## Put a model on a Squarespace page

Squarespace only runs JavaScript in Code Blocks on the Core, Plus, Advanced, Business, Commerce Basic, and Commerce Advanced plans. On a plan without it, the block saves and the viewer stays blank. See [Code blocks](https://support.squarespace.com/hc/en-us/articles/206543167-Code-blocks). The block itself must stay under Squarespace's 400 KB limit. This one is a few kilobytes. The model is loaded from the link, not pasted into the block.

1. Open the snippet for that chair and copy the whole file. Windsor is [`embed/model-viewer-snippet.html`](embed/model-viewer-snippet.html) and the armchair is [`embed/windsor-arm-snippet.html`](embed/windsor-arm-snippet.html). The Traditional chairs are [`embed/traditional-turned-snippet.html`](embed/traditional-turned-snippet.html) and [`embed/traditional-straight-snippet.html`](embed/traditional-straight-snippet.html).
2. Edit the product page → **Add block** → **Code** → set the type to **HTML** → paste.
3. On a store product, put the block in a section below the product details ([adding information to a product](https://support.squarespace.com/hc/en-us/articles/206541037-Add-additional-information-to-store-page-products)).
4. Save, then look at the page logged out or in a private window. Squarespace sometimes hides Code Block output while you are logged in. The help article above calls the workaround "Preview in Safe Mode".

Each snippet already points at that chair's jsDelivr addresses, with camera controls, auto-rotate, a ground shadow, a poster, a responsive frame, and AR (`webxr`, Scene Viewer, and Quick Look). "View in your room" uses the model's real size, so the file has to be in meters. The optimizer below does that.

For the next product, duplicate a snippet and change the two addresses and the alt text. Two snippets on one page are fine.

## Add another product

You will need [Node.js](https://nodejs.org) (the LTS installer) once, on the computer where you prepare the file.

### 1. Export a GLB from Twinmotion

Export one product, not the whole room. Hide the walls, floor, people, and plants first. The file should be a single `.glb` that includes the wood and fabric textures.

Twinmotion does not save a `.glb` itself (that export is still on Epic's request list). The path that works today:

1. In Twinmotion, choose **File → Export to Datasmith** and pick **Standard**. Save it on the Desktop. You get a `.udatasmith` file plus a folder of textures.
2. Open Unreal Engine and create a blank project. Drag the `.udatasmith` file into the Content Browser and let it import.
3. Find the furniture mesh, right-click it, and choose **Asset Actions → Export**. Set the type to **glTF 2.0 (`.glb`)**.
4. In the export options, set **Export Uniform Scale** to `0.01` if it is not already (Unreal's centimeters → the web's meters). Leave material baking on. If the wood comes out as a flat color, set **Bake Material Inputs** to **Use Mesh Data** and the bake size to **2048** or **4096**. Uncheck **Export Preview Mesh** when you see it.
5. Save the `.glb`. You can delete the Unreal project afterward.

A `.gltf` with its textures sitting in the same folder is fine too. The script packs them into one `.glb`. If a future Twinmotion version can export `.glb` directly, use that file the same way.

Menu names match Twinmotion and Unreal Engine as of 2025. If a label has moved, you want a Datasmith export from Twinmotion and a glTF `.glb` export from Unreal.

### Or export an OBJ from Fusion

Autodesk Fusion can save the piece as OBJ. That is the path used for the Traditional chairs.

1. Export one chair, not the whole design. Keep the `.obj` and the `.mtl` in the same folder. Fusion's MTL is usually only a flat color (a walnut or maple semigloss) and has no wood photograph. That is expected.
2. Put both files in `source/<product>/`. Those originals stay in the repository and are not copied to GitHub Pages.
3. Run the optimizer on the `.obj`. It reads the `.mtl` beside it. Fusion files are centimeters and Z-up. The script treats a `.obj` that way unless you pass `--units` or `--up`.
4. A flat wood color becomes a tileable semigloss grain, with the grain running along each leg, rail, and the seat. Walnut uses the photographic plank in `scripts/textures/` (colour and a pore normal). `--stain warm` is a brown walnut. `--stain grey` is the grey-brown used on the Windsor chairs. `--wood auto` reads the material name. A name containing "Walnut" or "Maple" selects that grain. Pass `--wood walnut` or `--wood maple` when the name does not say which. A material named leather, or a flat gray or black with no texture, becomes a soft matte leather and is left alone by `--wood`.

```bash
node scripts/optimize.mjs "source/traditional-turned/Traditional Turned Leg Chair.obj" models/traditional-turned/traditional-turned.glb
node scripts/optimize.mjs "source/traditional-straight/Simple Dining Chair.obj" models/traditional-straight/traditional-straight.glb
```

The turned-leg file is walnut. The straight tapered-leg file (`Simple Dining Chair`) is figured maple. Check the printed line `Wood: walnut grain` or `Wood: maple grain` before you commit.

### 2. Run the optimizer

In a terminal, from this repository:

```bash
npm install
node scripts/optimize.mjs "/path/to/Windsor.glb" models/windsor/windsor.glb --poster "/path/to/poster.png"
```

A Fusion OBJ uses the same command. The `.mtl` has to sit next to the `.obj`:

```bash
node scripts/optimize.mjs ~/Downloads/Chair.obj models/chair/chair.glb --wood maple
```

Use a new folder name for a new piece, in lowercase, with hyphens if you need them:

```bash
node scripts/optimize.mjs ~/Downloads/Sideboard.glb models/sideboard/sideboard.glb --poster ~/Downloads/sideboard.png
```

The script:

- Accepts a `.glb`, a `.gltf` (with its textures in the same folder), or a Fusion `.obj` plus `.mtl`.
- Converts the file to **meters** and **Y-up** (the web standard). Twinmotion, Unreal, and Fusion are Z-up and centimeter-based internally. Unreal's exporter usually converts this already. The script still checks, and fixes a file that was exported in centimeters or left Z-up. A `.obj` is assumed Z-up until you pass `--up y`.
- Centers the piece and sits it on the floor, which is what "View in your room" uses.
- Shrinks textures so the long side is at most **2048** pixels. Photographs (color, glow) become WebP. Normal maps and the other data textures become **lossless** WebP, so shading does not pick up compression blotches. A texture that is one flat color is stored as a material color instead.
- Compresses the mesh with **Draco**. `--compress meshopt` is the other option. `--compress none` leaves the mesh uncompressed.
- Drops cameras, lights, and animations. The page lights the piece itself.
- With `--poster`, writes a `poster.webp` no larger than 1600 pixels next to the model.

It prints the finished size, for example `58.0 cm wide × 65.0 cm deep × 102.0 cm tall`. Compare that with the real piece before you commit. A dining chair is usually about 90–110 cm tall.

| If the result looks… | Run the command again with |
|---|---|
| Huge or tiny | `--units cm`, `--units m`, `--units mm`, `--units in`, or `--units ft` |
| Lying on its side | `--up z` (or `--up y` if a `.obj` was already upright) |
| The wrong wood | `--wood walnut` or `--wood maple` |
| Larger than 20 MB | `--max-texture 1024` |

`auto` (the default) reads the longest side of the file: up to 20 is treated as meters, up to 2000 as centimeters, and anything longer as millimeters. `--units` overrides that.

A poster is the picture shoppers see while the model downloads. A straight-on or three-quarter screenshot is enough. `--poster` makes `poster.webp`. You can also drop in your own `poster.png` and name it in `models/catalog.json`.

### 3. List it, then commit

Add a block to `models/catalog.json` so the demo page shows the new piece:

```json
{
  "slug": "sideboard",
  "name": "Sideboard",
  "file": "sideboard.glb",
  "poster": "poster.webp",
  "alt": "3D model of the Sideboard",
  "note": ""
}
```

`slug` is the folder name. Commit the folder and the catalog. GitHub Desktop or the GitHub website both work: upload the new `models/<name>/` folder and the edited `models/catalog.json` onto the `main` branch.

### 4. Publish a tag

jsDelivr serves a tag forever, even after later edits.

1. On GitHub, open **Releases → Create a new release**.
2. Set the tag to `v1` for the first batch (then `v2`, `v3`, … when a model changes). Target the `main` branch.
3. Publish the release.

Put that tag in the Squarespace snippet (`@v1`, `@v2`, …). An old tag keeps serving the old file, so a product page does not change until you edit its snippet.

When you replace a model, publish a new tag and update the snippet. Pushing to `main` updates GitHub Pages on its own. It does not change an address that is pinned to `@v1`.

## Turn on GitHub Pages

The workflow in `.github/workflows/pages.yml` publishes `index.html`, `embed/`, and `models/` from `main`. It does not publish `source/`. Do this once, after this setup is merged:

1. Open **Settings → Pages** for [this repository](https://github.com/ArtesaoFineFurniture/artesao-3d-models/settings/pages).
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open the **Actions** tab. "Publish GitHub Pages" runs on the merge. When it is green, the demo is at `https://artesaofinefurniture.github.io/artesao-3d-models/`.

The repository has to stay **public**. jsDelivr and the shop both fetch the files anonymously. If Settings → Pages does not offer GitHub Actions, an organization owner has to allow Pages for the repository. The first successful run of the workflow is what creates the site.

You can re-run it any time from **Actions → Publish GitHub Pages → Run workflow**.

## Files

| Path | Purpose |
|---|---|
| `models/<product>/` | One folder per piece: the `.glb` and a poster |
| `models/catalog.json` | The list the demo page reads |
| `source/<product>/` | Original Fusion `.obj` and `.mtl`. Not published to GitHub Pages |
| `embed/model-viewer-snippet.html` | Squarespace Code Block for the Windsor side chair |
| `embed/windsor-arm-snippet.html` | Code Block for the Windsor armchair |
| `embed/traditional-turned-snippet.html` | Code Block for the turned-leg Traditional chair |
| `embed/traditional-straight-snippet.html` | Code Block for the straight-leg Traditional chair |
| `index.html` | The demo page GitHub Pages serves |
| `scripts/optimize.mjs` | The Node prep script (`@gltf-transform`, Sharp, Draco, Meshopt). Reads GLB, glTF, and Fusion OBJ+MTL |
| `scripts/textures/` | Photographic walnut grain used for walnut parts |
| `.github/workflows/pages.yml` | Publishes the site from `main` |

Check the script with `npm test` after `npm install`. Node.js 20 or newer.
