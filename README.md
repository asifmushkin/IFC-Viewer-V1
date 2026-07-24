# IFC 3D Viewer — Power BI Custom Visual

Renders IFC (BIM) models in 3D inside a Power BI report, using:
- **Microsoft's official Custom Visuals SDK** (`pbiviz` / `powerbi-visuals-tools`)
- **three.js** for rendering
- **web-ifc / web-ifc-three** (open-source, from That Open Company / IFC.js) for parsing IFC geometry

This is a from-scratch build using open tooling — it is **not** a copy of any commercial
product's code. It gets you the same category of capability (IFC in Power BI), but you
own and can modify every line.

## What's included

```
ifc-powerbi-visual/
├── package.json
├── pbiviz.json          # visual manifest
├── capabilities.json    # data roles, formatting pane objects, privileges
├── tsconfig.json
├── src/
│   ├── visual.ts         # main visual: scene setup, IFC loading, selection, tooltips
│   └── settings.ts        # formatting pane (background color, grid, highlight color, etc.)
├── style/visual.less
└── assets/icon.png       # placeholder — replace with a real 20x20 PNG
```

## 1. Prerequisites

```bash
node -v     # Node 18 LTS recommended
npm i -g powerbi-visuals-tools
pbiviz --install-cert     # installs the dev cert Power BI Desktop needs to load the live visual
```

Restart Power BI Desktop after installing the cert.

## 2. Install dependencies

```bash
cd ifc-powerbi-visual
npm install
```

## 3. Get the IFC WASM binaries in place

`web-ifc` ships its parser as a WASM module — this is not bundled automatically by the
default pbiviz webpack config, so copy it manually:

```bash
mkdir -p assets/wasm
cp node_modules/web-ifc/web-ifc.wasm assets/wasm/
cp node_modules/web-ifc/web-ifc-mt.wasm assets/wasm/
```

Then in `pbiviz.json`, make sure `assets/wasm/*.wasm` gets copied into the packaged
`.pbiviz` — the simplest reliable approach is a small `postbuild` step in `package.json`
that copies `assets/wasm` into `dist/` after `pbiviz package` runs, since asset handling
for binary/WASM files varies by `powerbi-visuals-tools` version. If `pbiviz start` in dev
mode 404s on the `.wasm` file, serve it from `assets/` at the path you set in
`ifcLoader.ifcManager.setWasmPath(...)` in `visual.ts`.

## 4. Run in dev mode (Power BI Desktop)

```bash
pbiviz start
```

In Power BI Desktop: **Insert → More visuals → Developer visual**, add it to a report,
then bind:
- **IFC File URL** → a text column containing a URL to an `.ifc` file (SharePoint,
  Azure Blob with a SAS token, or any HTTPS endpoint reachable from the client)
- **Element ID** (optional) → a column that maps IFC express IDs to other rows in your
  model, if you want cross-filtering on other visuals when someone clicks an element
- **Tooltip fields** (optional) → measures/columns to show when hovering an element

## 5. Package for distribution

```bash
pbiviz package
```

This produces `dist/ifc3dViewer.pbiviz`, which you can:
- Import directly into a report via **Insert → More visuals → Import a visual from a file**
- Or submit to **AppSource** / your **organizational visual store** for tenant-wide reuse

## Power BI Service considerations (important)

The Service sandboxes visuals more tightly than Desktop:

- **`WebAccess` privilege**: edit the domain list in `capabilities.json` under
  `privileges` to match wherever your IFC files actually live (your SharePoint tenant,
  Blob storage account, etc.). Wildcards like `https://*.sharepoint.com` work for the
  whole tenant; narrower is safer for org approval.
- **WASM + Web Workers**: `web-ifc` uses WASM and can use worker threads for multi-threaded
  parsing. Multi-threaded WASM (`web-ifc-mt.wasm`) needs `SharedArrayBuffer`, which requires
  cross-origin isolation headers the Power BI Service iframe may not set. If you hit
  `SharedArrayBuffer is not defined` in the Service, force single-threaded mode:
  ```ts
  await this.ifcLoader.ifcManager.useWebWorkers(false);
  ```
  at the top of `initIfcLoader()`.
- **Certified vs. non-certified visual**: for org-wide/AppSource distribution with full
  capabilities, Microsoft's visual certification process has extra restrictions (e.g. on
  external network calls) — read the current certification docs before submitting, since
  requirements change.
- **Large IFC files**: Power BI visuals have practical memory/render limits in a browser
  tab. For big models (hospitals, whole buildings), consider pre-simplifying geometry or
  streaming only visible IFC types.

## Known gaps to finish before production use

1. **Icon**: `assets/icon.png` is a placeholder — replace with a real 20×20 PNG.
2. **Element ID → SelectionId mapping**: `elementIdentities` (in `visual.ts`) is declared
   but not populated from the data view yet — you'll want to build it in `update()` from
   `dataView.categorical.values.grouped()` if you want two-way cross-filtering between the
   3D view and other visuals on the same page.
3. **Orbit controls**: a minimal custom implementation is included (drag/rotate,
   right-drag/pan, wheel/zoom) instead of `three/examples/jsm/controls/OrbitControls`,
   since deep imports from `three/examples` sometimes need extra webpack config in the
   pbiviz toolchain. Swap it in if you'd rather use the official one — add it to your
   `tsconfig.json`/webpack resolve paths.
4. **Testing**: none of this has been compiled or run (no network access in this
   environment) — expect to fix minor type/version mismatches between `web-ifc-three` and
   whatever `three.js` version npm resolves at install time. Pin exact versions in
   `package.json` if you hit incompatibilities.

## License note

`web-ifc` / `web-ifc-three` are open source (MIT-family licenses) — check the current
license terms in their repos before shipping commercially.
