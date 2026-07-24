"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

class SceneSettingsCard extends FormattingSettingsCard {
    backgroundColor = new formattingSettings.ColorPicker({
        name: "backgroundColor",
        displayName: "Background color",
        value: { value: "#1e1e1e" }
    });

    showGrid = new formattingSettings.ToggleSwitch({
        name: "showGrid",
        displayName: "Show ground grid",
        value: true
    });

    autoRotate = new formattingSettings.ToggleSwitch({
        name: "autoRotate",
        displayName: "Auto-rotate camera",
        value: false
    });

    name: string = "sceneSettings";
    displayName: string = "3D Scene";
    slices: FormattingSettingsSlice[] = [this.backgroundColor, this.showGrid, this.autoRotate];
}

class SelectionSettingsCard extends FormattingSettingsCard {
    highlightColor = new formattingSettings.ColorPicker({
        name: "highlightColor",
        displayName: "Highlight color",
        value: { value: "#ff8c00" }
    });

    enableCrossFilter = new formattingSettings.ToggleSwitch({
        name: "enableCrossFilter",
        displayName: "Cross-filter report on element click",
        value: true
    });

    name: string = "selectionSettings";
    displayName: string = "Selection";
    slices: FormattingSettingsSlice[] = [this.highlightColor, this.enableCrossFilter];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    sceneCard = new SceneSettingsCard();
    selectionCard = new SelectionSettingsCard();

    cards = [this.sceneCard, this.selectionCard];
}
