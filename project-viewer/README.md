# Private project viewer

This is a private page for one commission at a time. You drop in an FBX, the browser turns it into a GLB and an iPhone Quick Look USDZ, and you get a link you can send to that client. There is no list of projects on the public site. Someone who does not have the link gets the same “This page is not available.” page as any other unknown address.

GitHub Pages does not serve this folder. The shop’s public models stay in `models/` and `embed/`. This app is deployed on its own, to Netlify.

## File structure

```
project-viewer/
  netlify.toml                 Site settings: publish public/, functions, noindex headers
  package.json                 three.js (the converter) and Netlify Blobs
  lib/                         Shared server code, used by the functions and by local dev
    auth.mjs                   ADMIN_PASSWORD check (SHA-256, then timingSafeEqual)
    handlers.mjs               HTTP routes for admin and for the model files
    limits.mjs                 3 MB upload parts, 18 MB stored model
    local-blob-store.mjs       Disk stand-in for Netlify Blobs
    projects.mjs               Create, store, list, rename, delete
    store.mjs                  Netlify Blobs in production, disk when developing
    token.mjs                  16-byte (128-bit) token, base64url
    units.mjs                  Meters, centimeters, millimeters, inches, feet
  netlify/functions/
    admin.mjs                  Password-protected upload, list, rename, delete
    model.mjs                  GLB, USDZ, and the small JSON the viewer page reads
  public/                      The static site Netlify publishes
    index.html                 Same not-found page as an unknown address
    404.html                   Not-found page
    robots.txt                 Disallow: /
    admin/index.html           The upload page
    view/index.html            The client page. Same AR markup as embed/*-snippet.html
    js/admin.js                Drop zone, preview, upload
    js/convert.mjs             FBX → meters, on the floor, GLB and USDZ
    js/view.js                 Fills in the model URLs from the link
    js/limits.js               Same size caps as lib/limits.mjs
  scripts/
    dev-server.mjs             Local stand-in for Netlify (`npm run dev`)
    sample-fbx.mjs             Writes a stool-sized box as an FBX, for a trial run
    viewer.test.mjs            Conversion, storage, privacy, and a browser check
  fixtures/sample-stool.fbx   That box, 50 × 44 × 90 cm, so you can try the page
```

## Deploy on Netlify

Netlify’s free plan includes functions and blob storage. The free plan has 300 credits a month. When they are used up, the site pauses until the next month. Opening a model runs a function, so a handful of private links is a small amount of use. Do not publish the links on artesao.co.

1. Push this repository to GitHub and open the pull request. Merge it when you are happy with it. Nothing in this folder goes out on GitHub Pages.
2. In Netlify, add a site and import this GitHub repository.
3. Set the **base directory** to `project-viewer`. Leave the build command empty. The publish directory is `public` (already set in `netlify.toml`). If the form asks, that is the value to use.
4. Open **Site configuration → Environment variables** and add `ADMIN_PASSWORD`. Make it long and random, for example the output of `openssl rand -base64 24`. Up to 256 characters. Do not commit it, and do not put it in `netlify.toml`. It has to be available to Functions at runtime.
5. Deploy. Blobs do not need a separate database. They are stored with the site and they survive later deploys.
6. Open `https://<your-site>.netlify.app/admin`.

The live site stores files in a blob store named `project-viewer`. A deploy preview uses `project-viewer-preview`, so trying an upload on a preview does not replace a client’s model. Deleting the Netlify site deletes the models.

### Vercel

This build is for Netlify. The pages in `public/` are ordinary static files, but the upload is saved by Netlify Functions into Netlify Blobs, and `netlify.toml` is what wires that up. Vercel does not run those functions and does not have Netlify Blobs. Vercel Blob is a different service, and a Hobby serverless request is also capped at about 4.5 MB. Hosting the same app there would mean rewriting `lib/store.mjs` and the function entrypoints. Use Netlify.

Squarespace is not involved. The client opens the link. It is not a code block.

## Upload an FBX and send the link

1. Open `/admin` and enter the password. It is remembered until you close the tab or press Lock. It is not stored on the server in the browser’s permanent storage.
2. Drop an FBX. The page reads it in your browser with three.js (FBXLoader), shows it with a simple light, and scales it to real meters. The piece is centered and its base is put on the floor (y = 0). Textures are not kept. The shared model is the form and a solid color.
3. Check the size line. It is width × depth × height. A dining chair is usually about 90–110 cm tall. If the number is wrong, change **Units** and look again. **Auto** reads the FBX unit when the file has one (millimeters, centimeters, meters, inches, or feet). If the file does not say, Auto uses the same rule as the public model script: a longest side up to 20 is meters, up to 2000 is centimeters, and anything larger is millimeters. Use **Rotate onto the floor** only when the piece is lying on its side.
4. Type the project or client name and press **Create private link**.
5. Press **Copy** and send that link to the client. On a phone, **View in your room** uses the real size (`ar-scale="fixed"`, `ar-placement="floor"`). iPhone opens the USDZ in Quick Look. Android uses WebXR or Scene Viewer with the GLB.
6. The list under the form is only visible after the password. From there you can copy a link again, rename a project, or delete it. Deleting makes that link show the not-found page.

The FBX itself is never uploaded. The browser makes the GLB (GLTFExporter) and the USDZ (USDZExporter, Quick Look anchoring on the floor) and those two files are what get stored.

A trial file is `fixtures/sample-stool.fbx`. It is a box, 50 cm wide, 44 cm deep, and 90 cm tall. The size line should read about `50.0 cm wide × 44.0 cm deep × 90.0 cm tall`.

## Limits

| Limit | Why |
|---|---|
| Upload parts are 3 MB | A Netlify function request is capped at 6 MB, and a binary body is base64-encoded on the way in, which brings the practical cap to about 4.5 MB. The page sends the GLB and the USDZ in 3 MB parts. The parts are joined in the function and stored as one file. |
| Each of the GLB and the USDZ must be 18 MB or smaller | A normal function response is capped at 6 MB. The model is sent back as a stream, which raises the cap to 20 MB. 18 MB leaves a little room. An FBX of about 1–5 MB, without textures, fits. |
| FBX over 40 MB is refused in the browser | That is the room, not the piece. |
| One link is 128 bits | `crypto.getRandomValues` fills 16 bytes. The link is base64url. There is no index of links. |
| Password | Compared by hashing both sides with SHA-256 and then `timingSafeEqual`, so a wrong guess does not finish early. If `ADMIN_PASSWORD` is unset, nothing can be saved. |
| Textures | Not exported. Quick Look and the size limit both stay reliable. |
| Free plan credits | 300 a month. The site pauses when they run out. |

Android Scene Viewer downloads the GLB from the link. The link is the privacy. Anyone who has it can open the model, including Google’s viewer on Android. Don’t post it on a public page. `robots.txt` disallows the whole site, and every response sends `X-Robots-Tag: noindex`.

## Run it on your own computer

From this folder:

```bash
npm install
npm test
ADMIN_PASSWORD='a-local-password' npm run dev
```

Then open `http://127.0.0.1:8888/admin`. Uploads go in `.blob-data/`, which is not committed. A `.env` file in this folder is read if `ADMIN_PASSWORD` is not already set. Do not commit `.env`.

`npm test` builds a sample FBX, checks the GLB and the USDZ (meters, centered, sitting on the floor, Quick Look anchoring), stores them in small pieces, reads them back, checks that a wrong password and an unknown link give nothing away, and opens the admin page and the viewer in headless Chrome.

`npx netlify dev` is the other way to run it. With that command, leave `PROJECT_VIEWER_BLOB_DIR` unset so `@netlify/blobs` uses Netlify’s local blob server. `npm run dev` is the one the tests use, and it does not need the Netlify CLI.

## To do before you send a client a link

- [ ] Merge the pull request when you have reviewed it.
- [ ] Create the Netlify site with base directory `project-viewer`.
- [ ] Set `ADMIN_PASSWORD` in the Netlify UI. Do not commit it.
- [ ] Deploy, open `/admin`, and try `fixtures/sample-stool.fbx`. The size should be about 50 × 44 × 90 cm.
- [ ] Upload a real piece and compare the size line with the real piece before you copy the link.
- [ ] Open the link on your iPhone and on an Android phone. Press **View in your room** and check the size in the room.
- [ ] Send the link privately. Do not put `/admin` or these links on artesao.co.
- [ ] Delete a project when that client no longer needs it.
- [ ] Keep an eye on Netlify’s credit counter. The free plan pauses at 300 credits.
