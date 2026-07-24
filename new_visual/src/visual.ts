"use strict";

import powerbi from "powerbi-visuals-api";
import * as THREE from "three";
import { IFCLoader } from "web-ifc-three/IFCLoader";
import { IFCModel } from "web-ifc-three/IFC/components/IFCModel";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import JSZip from "jszip";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualFormattingSettingsModel } from "./settings";
import { WEB_IFC_WASM_BASE64 } from "./webifc-wasm-base64";

import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import DataView = powerbi.DataView;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;

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
    private ifcLoader: IFCLoader;
    private currentModel: IFCModel | null = null;
    private currentUrl: string | null = null;
    private fileInput: HTMLInputElement;
    private uploadButton: HTMLButtonElement;
    private resetButton: HTMLButtonElement;
    private statusLabel: HTMLDivElement;
    private isLocalFileLoaded = false;
    private localFileName: string | null = null;
    private raycaster: THREE.Raycaster;
    private mouse: THREE.Vector2;
    private animationFrameId: number;

    private sceneSettings: SceneSettings = {
        backgroundColor: "#1e1e1e",
        showGrid: true,
        autoRotate: false
    };

    private selectionSettings: SelectionSettings = {
        highlightColor: "#ff8c00",
        enableCrossFilter: true
    };

    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;

    constructor(options: VisualConstructorOptions) {
        this.target = options.element;
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.formattingSettingsService = new FormattingSettingsService();
        this.target.style.position = "relative";

        this.fileInput = document.createElement("input");
        this.fileInput.type = "file";
        this.fileInput.accept = ".ifc,.ifc.zip";
        this.fileInput.style.display = "none";
        this.fileInput.addEventListener("change", async () => {
            const file = this.fileInput.files?.[0];
            if (!file) return;
            await this.loadIfcFile(file);
        });
        this.target.appendChild(this.fileInput);

        this.uploadButton = document.createElement("button");
        this.uploadButton.className = "powerbi3d-button";
        this.uploadButton.textContent = "Upload IFC";
        this.uploadButton.style.position = "absolute";
        this.uploadButton.style.top = "8px";
        this.uploadButton.style.left = "8px";
        this.uploadButton.style.zIndex = "10";
        this.uploadButton.style.minWidth = "90px";
        this.uploadButton.style.padding = "6px 10px";
        this.uploadButton.style.fontSize = "12px";
        this.uploadButton.addEventListener("click", () => this.fileInput.click());
        this.target.appendChild(this.uploadButton);

        this.resetButton = document.createElement("button");
        this.resetButton.className = "powerbi3d-button";
        this.resetButton.textContent = "Reset model";
        this.resetButton.style.position = "absolute";
        this.resetButton.style.top = "8px";
        this.resetButton.style.left = "110px";
        this.resetButton.style.zIndex = "10";
        this.resetButton.style.minWidth = "90px";
        this.resetButton.style.padding = "6px 10px";
        this.resetButton.style.fontSize = "12px";
        this.resetButton.disabled = true;
        this.resetButton.addEventListener("click", () => this.resetModel());
        this.target.appendChild(this.resetButton);

        this.statusLabel = document.createElement("div");
        this.statusLabel.style.position = "absolute";
        this.statusLabel.style.top = "8px";
        this.statusLabel.style.right = "8px";
        this.statusLabel.style.zIndex = "10";
        this.statusLabel.style.padding = "6px 10px";
        this.statusLabel.style.fontSize = "12px";
        this.statusLabel.style.color = "#ffffff";
        this.statusLabel.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
        this.statusLabel.style.borderRadius = "4px";
        this.statusLabel.style.pointerEvents = "none";
        this.statusLabel.textContent = "No model loaded";
        this.target.appendChild(this.statusLabel);

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

        this.initSimpleOrbitControls();
        this.animate();
    }

    private initSimpleOrbitControls(): void {
        let isDragging = false;
        let isPanning = false;
        let prevX = 0;
        let prevY = 0;
        const target = new THREE.Vector3(0, 0, 0);

        this.canvas.addEventListener("mousedown", (e) => {
            if (e.button === 2) {
                isPanning = true;
            } else {
                isDragging = true;
            }
            prevX = e.clientX;
            prevY = e.clientY;
        });

        window.addEventListener("mouseup", () => {
            isDragging = false;
            isPanning = false;
        });

        this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

        this.canvas.addEventListener("mousemove", (e) => {
            const dx = e.clientX - prevX;
            const dy = e.clientY - prevY;
            prevX = e.clientX;
            prevY = e.clientY;

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
    }

    private initIfcLoader(): void {
        this.ifcLoader = new IFCLoader();
        const wasmPath = "assets/wasm/";
        this.ifcLoader.ifcManager.setWasmPath(wasmPath);
        // If we have an embedded base64 WASM, monkey-patch fetch to return it
        // for requests to the wasm file. This avoids network fetch issues in
        // restrictive host environments (Power BI sandbox/CDN restrictions).
        if (typeof WEB_IFC_WASM_BASE64 === 'string' && WEB_IFC_WASM_BASE64.length > 0) {
            try {
                const originalFetch = (window as any).fetch.bind(window);
                (window as any).fetch = async (input: any, init?: any) => {
                    try {
                        const url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
                        if (url && url.toLowerCase().endsWith('web-ifc.wasm')) {
                            const binary = Uint8Array.from(atob(WEB_IFC_WASM_BASE64), c => c.charCodeAt(0));
                            return new Response(binary, { headers: { 'Content-Type': 'application/wasm' } });
                        }
                    } catch (e) {
                        console.warn('Embedded WASM fetch fallback failed:', e);
                    }
                    return originalFetch(input, init);
                };
                console.log('Installed embedded WASM fetch fallback');
            } catch (e) {
                console.warn('Failed to install embedded WASM fetch fallback:', e);
            }
        }
        // Diagnostic: try fetching the wasm directly so we can surface clearer errors
        (async () => {
            try {
                const resp = await fetch(wasmPath + "web-ifc.wasm");
                if (!resp.ok) {
                    console.error("WASM fetch failed with status:", resp.status, resp.statusText);
                    this.setStatus(`WASM fetch failed: ${resp.status}`, true);
                } else {
                    console.log("WASM is accessible at", wasmPath + "web-ifc.wasm");
                }
            } catch (err) {
                console.error("Failed to fetch WASM for diagnostics:", err);
                this.setStatus(`Failed to fetch WASM: ${err instanceof Error ? err.message : String(err)}`, true);
            }
        })();
        try {
            const managerAny = this.ifcLoader.ifcManager as any;
            if (typeof managerAny.useWebWorkers === "function") {
                managerAny.useWebWorkers(false);
            }
        } catch (e) {
            console.warn("ifcManager.useWebWorkers disabled failed:", e);
        }
    }

    private async loadIfcFile(file: File): Promise<void> {
        const fileName = file.name;
        const lowerFileName = fileName.toLowerCase();

        if (lowerFileName.endsWith(".ifc")) {
            await this.loadIfcBuffer(await file.arrayBuffer(), fileName);
            return;
        }

        if (lowerFileName.endsWith(".ifc.zip") || lowerFileName.endsWith(".ifczip")) {
            this.setStatus("Extracting IFC from ZIP...");
            try {
                const zip = await JSZip.loadAsync(await file.arrayBuffer());
                const ifcEntry = Object.values(zip.files).find((entry) => entry.name.toLowerCase().endsWith(".ifc"));
                if (!ifcEntry) {
                    this.setStatus("No .ifc file found inside ZIP archive.", true);
                    return;
                }
                const ifcBuffer = await ifcEntry.async("arraybuffer");
                this.localFileName = ifcEntry.name;
                this.isLocalFileLoaded = true;
                this.currentUrl = null;
                await this.loadIfcBuffer(ifcBuffer, ifcEntry.name);
            } catch (err) {
                console.error("Failed to unzip IFC archive:", err);
                this.setStatus("Could not read .ifc.zip archive.", true);
            }
            return;
        }

        this.setStatus("Selected file is not a supported IFC file.", true);
    }

    private async loadIfcBuffer(buffer: ArrayBuffer, fileName?: string): Promise<void> {
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            await this.ifcLoader.ifcManager.dispose();
            this.initIfcLoader();
        }

        this.setStatus("Loading local IFC...");
        try {
            const model = await this.ifcLoader.ifcManager.parse(buffer);
            model.name = "ifcModel";
            this.currentModel = model;
            this.scene.add(model);
            this.frameCameraToModel(model);
            if (fileName) {
                this.localFileName = fileName;
            }
            this.setStatus(this.localFileName ? `Local: ${this.localFileName}` : "Local IFC loaded");
            this.resetButton.disabled = false;
        } catch (err) {
            console.error("Failed to load IFC model from buffer:", err);
            const message = err instanceof Error ? err.message : String(err);
            this.setStatus("Could not load IFC file. Please select a valid .ifc file.", true);
            this.host.tooltipService.show({
                dataItems: [
                    { displayName: "Error", value: "Could not load IFC file. Please select a valid .ifc file." },
                    { displayName: "Details", value: message }
                ],
                identities: [],
                coordinates: [10, 10],
                isTouchEvent: false
            });
        }
    }

    private setStatus(message: string, isError = false): void {
        this.statusLabel.textContent = message;
        this.statusLabel.style.color = isError ? "#ff6666" : "#ffffff";
    }

    private async handleSelection(intersection: THREE.Intersection, event: MouseEvent): Promise<void> {
        if (!this.currentModel) return;

        const mesh = intersection.object as THREE.Mesh;
        if (!mesh.geometry || intersection.faceIndex === undefined) return;

        const expressId = this.ifcLoader.ifcManager.getExpressId(mesh.geometry, intersection.faceIndex);
        const properties = await this.ifcLoader.ifcManager.getItemProperties(this.currentModel.modelID, expressId, true);

        const dataItems = this.buildTooltipDataItems(properties);
        const coordinates = [event.clientX, event.clientY];

        this.host.tooltipService.show({
            dataItems,
            identities: [],
            coordinates,
            isTouchEvent: false
        });
    }

    private buildTooltipDataItems(properties: any[]): Array<{ displayName: string; value: string }> {
        const dataItems: Array<{ displayName: string; value: string }> = [];
        for (const property of properties) {
            if (!property) continue;
            const displayName = property.PropertySet?.Name || property.Name || property.ifcType || property.type || property.GlobalId || property.Name;
            const value = this.formatPropertyValue(property);
            if (displayName && value !== undefined) {
                dataItems.push({ displayName: String(displayName), value: String(value) });
            }
        }
        return dataItems.length > 0 ? dataItems : [{ displayName: "Element", value: `#${properties[0]?.id ?? "unknown"}` }];
    }

    private formatPropertyValue(property: any): string | undefined {
        if (property === null || property === undefined) return undefined;
        if (typeof property === "string" || typeof property === "number" || typeof property === "boolean") {
            return String(property);
        }
        if (Array.isArray(property)) {
            return property.map((item) => this.formatPropertyValue(item)).filter(Boolean).join(", ");
        }
        if (typeof property === "object") {
            if (property.value !== undefined) return String(property.value);
            return Object.entries(property)
                .map(([key, value]) => `${key}: ${this.formatPropertyValue(value)}`)
                .filter(Boolean)
                .join("; ");
        }
        return undefined;
    }

    private resetModel(): void {
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            this.currentModel = null;
        }
        this.currentUrl = null;
        this.isLocalFileLoaded = false;
        this.localFileName = null;
        this.statusLabel.textContent = "No model loaded";
        this.resetButton.disabled = true;
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

                await this.handleSelection(intersection, event);
            }
        });
    }

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
        if (!this.isLocalFileLoaded && url && url !== this.currentUrl) {
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
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();

            const model = await this.ifcLoader.ifcManager.parse(buffer);
            model.name = "ifcModel";
            this.currentModel = model;
            this.scene.add(model);
            this.frameCameraToModel(model);
            const shortUrl = url.length > 40 ? `${url.slice(0, 40)}...` : url;
            this.statusLabel.textContent = `URL: ${shortUrl}`;
            this.resetButton.disabled = false;
        } catch (err) {
            console.error("Failed to load IFC model:", err);
            this.host.tooltipService.show({
                dataItems: [{ displayName: "Error", value: "Could not load IFC file. Provide a raw IFC URL." }],
                identities: [],
                coordinates: [10, 10],
                isTouchEvent: false
            });
        }
    }

    private frameCameraToModel(model: THREE.Object3D): void {
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 1.5;
        this.camera.position.set(center.x + distance, center.y + distance, center.z + distance);
        this.camera.lookAt(center);
    }

    private animate(): void {
        if (this.sceneSettings.autoRotate && this.currentModel) {
            this.currentModel.rotation.y += 0.002;
        }
        this.renderer.render(this.scene, this.camera);
        this.animationFrameId = requestAnimationFrame(() => this.animate());
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    public destroy(): void {
        cancelAnimationFrame(this.animationFrameId);
        this.renderer.dispose();
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            this.currentModel = null;
        }
        while (this.target.firstChild) {
            this.target.removeChild(this.target.firstChild);
        }
    }
}
