"use strict";

import powerbi from "powerbi-visuals-api";
import * as THREE from "three";
import { IFCLoader } from "web-ifc-three/IFCLoader";
import { IFCModel } from "web-ifc-three/IFC/components/IFCModel";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualFormattingSettingsModel } from "./settings";

import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import DataView = powerbi.DataView;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import FormattingModel = powerbi.visuals.FormattingModel;

interface SceneSettings {
    backgroundColor: string;
    showGrid: boolean;
    autoRotate: boolean;
}

interface SelectionSettings {
    highlightColor: string;
    enableCrossFilter: boolean;
}

export class Visual implements IVisual {
    private target: HTMLElement;
    private host: IVisualHost;
    private selectionManager: ISelectionManager;

    private canvas: HTMLCanvasElement;
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private controls: any; // OrbitControls (loaded lazily, see initControls)
    private ifcLoader: IFCLoader;
    private currentModel: IFCModel | null = null;
    private currentUrl: string | null = null;
    private raycaster: THREE.Raycaster;
    private mouse: THREE.Vector2;

    private sceneSettings: SceneSettings = {
        backgroundColor: "#1e1e1e",
        showGrid: true,
        autoRotate: false
    };

    private selectionSettings: SelectionSettings = {
        highlightColor: "#ff8c00",
        enableCrossFilter: true
    };

    private animationFrameId: number;
    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;

    constructor(options: VisualConstructorOptions) {
        this.target = options.element;
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.formattingSettingsService = new FormattingSettingsService();

        this.canvas = document.createElement("canvas");
        this.canvas.style.width = "100%";
        this.canvas.style.height = "100%";
        this.canvas.style.display = "block";
        this.target.appendChild(this.canvas);

        this.initThree();
        this.initIfcLoader();
        this.registerClickHandler();
    }

    private initThree(): void {
        THREE.Mesh.prototype.raycast = acceleratedRaycast;
        (THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
        (THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.sceneSettings.backgroundColor);

        const width = this.target.clientWidth || 300;
        const height = this.target.clientHeight || 300;

        this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 5000);
        this.camera.position.set(20, 20, 20);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
        this.scene.add(hemiLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(10, 20, 10);
        this.scene.add(dirLight);

        const grid = new THREE.GridHelper(100, 50, 0x555555, 0x333333);
        grid.name = "__grid";
        this.scene.add(grid);

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // Lightweight orbit-style controls without importing three/examples
        // (Power BI's webpack sandbox is picky about deep imports from three/examples/jsm).
        this.initSimpleOrbitControls();

        this.animate();
    }

    // Minimal orbit control implementation (drag-to-rotate, wheel-to-zoom, right-drag-to-pan)
    // Avoids importing three/examples/jsm/controls/OrbitControls to keep the bundle predictable
    // under the Power BI visuals webpack config. Swap for the official OrbitControls if you
    // add three/examples to your webpack resolve config.
    private initSimpleOrbitControls(): void {
        let isDragging = false;
        let isPanning = false;
        let prevX = 0, prevY = 0;
        const target = new THREE.Vector3(0, 0, 0);

        this.canvas.addEventListener("mousedown", (e) => {
            if (e.button === 2) { isPanning = true; } else { isDragging = true; }
            prevX = e.clientX; prevY = e.clientY;
        });
        window.addEventListener("mouseup", () => { isDragging = false; isPanning = false; });
        this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

        this.canvas.addEventListener("mousemove", (e) => {
            const dx = e.clientX - prevX;
            const dy = e.clientY - prevY;
            prevX = e.clientX; prevY = e.clientY;

            if (isDragging) {
                const spherical = new THREE.Spherical().setFromVector3(
                    this.camera.position.clone().sub(target)
                );
                spherical.theta -= dx * 0.005;
                spherical.phi = Math.min(Math.max(spherical.phi + dy * 0.005, 0.05), Math.PI - 0.05);
                const newPos = new THREE.Vector3().setFromSpherical(spherical).add(target);
                this.camera.position.copy(newPos);
                this.camera.lookAt(target);
            } else if (isPanning) {
                const panSpeed = 0.05;
                const right = new THREE.Vector3();
                this.camera.getWorldDirection(right);
                right.cross(this.camera.up).normalize();
                const up = this.camera.up.clone();
                const move = right.multiplyScalar(-dx * panSpeed).add(up.multiplyScalar(dy * panSpeed));
                this.camera.position.add(move);
                target.add(move);
            }
        });

        this.canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            const dir = this.camera.position.clone().sub(target);
            const scale = e.deltaY > 0 ? 1.1 : 0.9;
            dir.multiplyScalar(scale);
            this.camera.position.copy(target.clone().add(dir));
        }, { passive: false });

        this.controls = { target };
    }

    private initIfcLoader(): void {
        this.ifcLoader = new IFCLoader();
        // WASM files must be shipped alongside the bundled visual assets.
        // Copy node_modules/web-ifc/*.wasm into ./assets/wasm/ (see README) and reference it here.
        this.ifcLoader.ifcManager.setWasmPath("assets/wasm/");

        // Power BI Service often runs inside an iframe without cross-origin isolation,
        // which prevents use of SharedArrayBuffer required by multi-threaded WASM.
        // Force single-threaded mode to ensure the visual works in Power BI Service.
        try {
            const managerAny = this.ifcLoader.ifcManager as any;
            if (typeof managerAny.useWebWorkers === 'function') {
                // prefer synchronous call if available
                managerAny.useWebWorkers(false);
            }
        } catch (e) {
            // If setting fails, log a warning and continue; fallback will be single-threaded.
            // eslint-disable-next-line no-console
            console.warn('ifcManager.useWebWorkers disabled failed:', e);
        }
    }

    private registerClickHandler(): void {
        this.canvas.addEventListener("click", async (event) => {
            if (!this.currentModel) return;
            const rect = this.canvas.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);
            const intersects = this.raycaster.intersectObject(this.currentModel);

            if (intersects.length > 0) {
                const intersection = intersects[0];
                const mesh = intersection.object as THREE.Mesh;
                if (!mesh.geometry || intersection.faceIndex === undefined) return;

                const expressId = this.ifcLoader.ifcManager.getExpressId(
                    mesh.geometry,
                    intersection.faceIndex
                );

                await this.ifcLoader.ifcManager.createSubset({
                    modelID: this.currentModel.modelID,
                    ids: [expressId],
                    scene: this.scene,
                    removePrevious: true,
                    material: new THREE.MeshBasicMaterial({
                        color: new THREE.Color(this.selectionSettings.highlightColor),
                        depthTest: false
                    })
                });

                const props = await this.ifcLoader.ifcManager.getItemProperties(
                    this.currentModel.modelID, expressId, true
                );
                this.host.tooltipService.show({
                    dataItems: Object.entries(props)
                        .filter(([, v]) => v && typeof v === "object" && "value" in (v as any))
                        .slice(0, 10)
                        .map(([key, v]: [string, any]) => ({ displayName: key, value: String(v.value) })),
                    identities: [],
                    coordinates: [event.clientX, event.clientY],
                    isTouchEvent: false
                });

                if (this.selectionSettings.enableCrossFilter) {
                    // Cross-filter the report using whatever selection ID maps to this element,
                    // wired up in update() via elementIdentities.
                    const identity = this.elementIdentities.get(expressId);
                    if (identity) {
                        this.selectionManager.select(identity);
                    }
                }
            }
        });
    }

    private elementIdentities: Map<number, powerbi.visuals.ISelectionId> = new Map();

    public async update(options: VisualUpdateOptions): Promise<void> {
        const dataView: DataView = options.dataViews && options.dataViews[0];
        if (!dataView) return;

        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(
            VisualFormattingSettingsModel, dataView
        );
        this.sceneSettings.backgroundColor = this.formattingSettings.sceneCard.backgroundColor.value.value;
        this.sceneSettings.showGrid = this.formattingSettings.sceneCard.showGrid.value;
        this.sceneSettings.autoRotate = this.formattingSettings.sceneCard.autoRotate.value;
        this.selectionSettings.highlightColor = this.formattingSettings.selectionCard.highlightColor.value.value;
        this.selectionSettings.enableCrossFilter = this.formattingSettings.selectionCard.enableCrossFilter.value;

        const width = options.viewport.width;
        const height = options.viewport.height;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.scene.background = new THREE.Color(this.sceneSettings.backgroundColor);
        const grid = this.scene.getObjectByName("__grid");
        if (grid) grid.visible = this.sceneSettings.showGrid;

        const url = this.extractIfcUrl(dataView);
        if (url && url !== this.currentUrl) {
            this.currentUrl = url;
            await this.loadModel(url);
        }
    }

    private extractIfcUrl(dataView: DataView): string | null {
        const categorical = dataView.categorical;
        if (!categorical || !categorical.categories || categorical.categories.length === 0) return null;
        const values = categorical.categories[0].values;
        if (!values || values.length === 0) return null;
        return String(values[0]);
    }

    private async loadModel(url: string): Promise<void> {
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            await this.ifcLoader.ifcManager.dispose();
            this.initIfcLoader();
        }

        try {
            // NOTE: In Power BI Service, this fetch is subject to the WebAccess privilege
            // domain allow-list declared in capabilities.json. Update it to match your
            // actual SharePoint/Blob storage domain(s) before packaging.
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();

            if (!this.isLikelyIfc(buffer)) {
                throw new Error("Fetched content does not appear to be a valid IFC STEP file.");
            }

            const model = await this.ifcLoader.ifcManager.parse(buffer);
            model.name = "ifcModel";
            this.currentModel = model;
            this.scene.add(model);
            this.frameCameraToModel(model);
        } catch (err) {
            console.error("Failed to load IFC model:", err);
            this.host.tooltipService.show({
                dataItems: [{
                    displayName: "Error",
                    value: "Could not load IFC file. Ensure the URL points to a raw .ifc file and that Power BI Service has permission to fetch it."
                }],
                identities: [],
                coordinates: [10, 10],
                isTouchEvent: false
            });
        }
    }

    private isLikelyIfc(buffer: ArrayBuffer): boolean {
        const sampleBytes = new Uint8Array(buffer.slice(0, 128));
        const text = new TextDecoder("utf-8", { fatal: false }).decode(sampleBytes).trim().toUpperCase();
        return text.startsWith("ISO-10303-21;") || text.includes("FILE_SCHEMA") || text.includes("DATA;");
    }

    private frameCameraToModel(model: THREE.Object3D): void {
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const dist = maxDim * 1.6;
        this.camera.position.set(center.x + dist, center.y + dist, center.z + dist);
        this.camera.lookAt(center);
        (this.controls as any).target.copy(center);
    }

    public getFormattingModel(): FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    private animate = (): void => {
        this.animationFrameId = requestAnimationFrame(this.animate);
        if (this.sceneSettings.autoRotate && this.currentModel) {
            this.currentModel.rotation.z += 0.002;
        }
        this.renderer.render(this.scene, this.camera);
    };

    public destroy(): void {
        cancelAnimationFrame(this.animationFrameId);
        this.renderer.dispose();
    }
}
