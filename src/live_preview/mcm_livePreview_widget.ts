/*
 * Filename: multi-column-markdown/src/live_preview/MultiColumnMarkdown_Widget.ts
 * Created Date: Tuesday, August 16th 2022, 4:38:43 pm
 * Author: Cameron Robinson
 * 
 * Copyright (c) 2022 Cameron Robinson
 */

import { MarkdownRenderChild, MarkdownRenderer, TFile, WorkspaceLeaf } from "obsidian";
import { WidgetType } from "@codemirror/view";
import { getDefaultMultiColumnSettings, MultiColumnSettings } from "../regionSettings";
import { parseSingleColumnSettings } from "../utilities/settingsParser";
import { StandardMultiColumnRegionManager } from "../dom_manager/regional_managers/standardMultiColumnRegionManager";
import { RegionManagerData } from "../dom_manager/regional_managers/regionManagerContainer";
import { getUID } from "../utilities/utils";
import { DOMObject, DOMObjectTag, ElementColumnBreakType } from "../dom_manager/domObject";
import { RegionManager } from "../dom_manager/regional_managers/regionManager";
import { SingleColumnRegionManager } from "../dom_manager/regional_managers/singleColumnRegionManager";
import { AutoLayoutRegionManager } from "../dom_manager/regional_managers/autoLayoutRegionManager";
import { MultiColumnStyleCSS } from "src/utilities/cssDefinitions";
import { isTasksPlugin } from "src/utilities/elementRenderTypeParser";
import { RegionErrorManager } from "src/dom_manager/regionErrorManager";
import { RegionType } from "src/utilities/interfaces";
import { parseColBreakErrorType } from "src/utilities/errorMessage";
import { checkForParagraphInnerColEndTag, containsColEndTag } from "src/utilities/textParser";

const CACHE_MAX_DELTA_TIME_MS = 2 * 60 * 1000; // 2m

interface cacheData {
    timestamp: number,
    element: HTMLElement
}

let livePreviewElementCache: Map<string, cacheData> = new Map()
async function clearCache(skipKey: string = "") {

    let index = -1;
    let keys = Array.from(livePreviewElementCache.keys())
    for(let key of keys) {
        index++

        if(key === skipKey) {
            // console.debug(`Element: ${index} | Skipping key: ${key.split(" : ")[0]}`)
            continue;
        }

        if(livePreviewElementCache.has(key) === false) {
            continue;
        } 

        let val = livePreviewElementCache.get(key)

        let deltaTimeMS = Date.now() - val.timestamp
        if((val.element.parentNode === null || val.element.parentNode.parentNode === null) && deltaTimeMS > CACHE_MAX_DELTA_TIME_MS) {
            // console.debug(`cache delta: ${deltaTimeMS} > ${CACHE_MAX_DELTA_TIME_MS} or 2 minutes.`)
            livePreviewElementCache.delete(key)
        }
        else if(val.element.parentNode == null || val.element.parentNode.parentNode === null) {
            
            // console.debug(`Element ${index} null but not removing from cache yet. \nElement file path: ${key.split(" : ")[0]} \nPath Elapsed time: ${Math.floor(deltaTimeMS / 1000)}`)
        }
    }
}

export class MultiColumnMarkdown_LivePreview_Widget extends WidgetType {

    contentData: string;
    tempParent: HTMLDivElement;
    domList: DOMObject[] = [];
    settingsText: string;
    regionSettings: MultiColumnSettings = getDefaultMultiColumnSettings();
    regionManager: RegionManager;
    sourceFile: TFile;
    sourcePath: string = "";
    elementCacheID: string;

    constructor(originalText: string, contentData: string, userSettings: MultiColumnSettings, sourceFile: TFile, settingsText: string = "", regionType: RegionType) {
        super();
        this.contentData = contentData;
        this.settingsText = settingsText;
        this.sourceFile = sourceFile;

        this.elementCacheID = `${this.sourceFile.path} : ${this.contentData}`;

        if(this.sourceFile) {
            this.sourcePath = sourceFile.path;
        }

        if(userSettings !== null) {
            this.regionSettings = userSettings;
        }

        // Render the markdown content to our temp parent element.
        this.tempParent = createDiv();
        let elementMarkdownRenderer = new MarkdownRenderChild(this.tempParent);
        MarkdownRenderer.renderMarkdown(this.contentData, this.tempParent, this.sourcePath, elementMarkdownRenderer);

        let errorManager = new RegionErrorManager(createDiv());
        if(regionType === "CODEBLOCK") {
            errorManager.addErrorMessage("The codeblock region start syntax has been depreciated. Please update to the current syntax in the ReadMe or use the Update Depreciated Syntax command in the plugin settings. You must reload the file for changes to take effect.")
        }
        
        let workingText = contentData;
        // take all elements, in order, and create our DOM list.
        let arr = Array.from(this.tempParent.children);
        for (let i = 0; i < arr.length; i++) {

            let el = this.fixElementRender(arr[i]);

            let domObject = new DOMObject(el as HTMLElement, [""])
            this.domList.push(domObject);

            workingText = checkForColumnBreakErrors(domObject, workingText, errorManager)
        }

        // Set up the region manager data before then creating our region manager.
        let regionData: RegionManagerData = {
            domList: this.domList,
            domObjectMap: new Map<string, DOMObject>(),
            regionParent: createDiv(),
            fileManager: null,
            regionalSettings: this.regionSettings,
            regionKey: getUID(),
            rootElement: createDiv(),
            errorManager: errorManager
        };

        // Finally setup the type of region manager required.
        if (this.regionSettings.numberOfColumns === 1) {
            this.regionSettings = parseSingleColumnSettings(this.settingsText, this.regionSettings);
            this.regionManager = new SingleColumnRegionManager(regionData);
        }
        else if (this.regionSettings.autoLayout === true) {
            this.regionManager = new AutoLayoutRegionManager(regionData, true);
        }
        else {
            this.regionManager = new StandardMultiColumnRegionManager(regionData);
        }

        clearCache(this.elementCacheID)
    }

    fixElementRender(el: Element): Element {

        let fixedEl = fixImageRender(el, this.sourcePath);
        fixedEl = fixPDFRender(fixedEl, this.sourcePath);
        fixedEl = fixFileEmbed(fixedEl, this.sourcePath);
        fixedEl = fixTableRender(fixedEl);
        fixedEl = fixUnSupportedRender(fixedEl);
        return fixedEl;
    }

    toDOM() {

        if(livePreviewElementCache.has(this.elementCacheID)) {
            return livePreviewElementCache.get(this.elementCacheID).element
        }

        // Create our element to hold all of the live preview elements.
        let el = document.createElement("div");
        el.className = "mcm-cm-preview";

        /**
         * For situations where we need to know the rendered height, AutoLayout, 
         * the element must be rendered onto the screen to get the info, even if 
         * only for a moment. Here we attempt to get a leaf from the app so we 
         * can briefly append our element, check any data if required, and then
         * remove it.
         */
        let leaf: WorkspaceLeaf = null;
        if (app) {
            let leaves = app.workspace.getLeavesOfType("markdown");
            if (leaves.length > 0) {
                leaf = leaves[0];
            }
        }

        if (this.regionManager) {

            this.regionManager.getRegionData().errorManager.setRegionRootElement(el)
            let contentElement = el.createDiv()

            let requireUnload = false
            if (leaf && this.regionManager instanceof AutoLayoutRegionManager) {
                leaf.view.containerEl.appendChild(el);
                requireUnload = true
            }

            this.regionManager.renderRegionElementsToLivePreview(contentElement);

            if (requireUnload) {
                leaf.view.containerEl.removeChild(el);
            }
        }

        fixExternalLinks(el)

        livePreviewElementCache.set(this.elementCacheID, {
            timestamp: Date.now(),
            element: el
        })

        return el;
    }
}

export class MultiColumnMarkdown_DefinedSettings_LivePreview_Widget extends WidgetType {

    contentData: string;

    constructor(contentData: string) {
        super();

        this.contentData = contentData;
    }

    toDOM() {
        // Create our element to hold all of the live preview elements.
        let el = document.createElement("div");
        el.className = "mcm-cm-settings-preview";

        let labelDiv = el.createDiv()
        let label = labelDiv.createSpan({
            cls: "mcm-col-settings-preview"
        })
        label.textContent = "Column Settings:";

        let list = el.createEl("ul")
        let lines = this.contentData.split("\n")
        for(let i = 1; i < lines.length - 1; i++) {
            let item = list.createEl("li")
            item.textContent = lines[i]
        }

        return el;
    }
}

const OBSIDIAN_LIVEPREVIEW_TABLE_CLASSES = "cm-embed-block markdown-rendered cm-table-widget show-indentation-guide"
function fixTableRender(el: Element): Element {

    if(el.tagName !== "TABLE") {
        return el;
    }

    let parentDiv = createDiv({
        "cls": OBSIDIAN_LIVEPREVIEW_TABLE_CLASSES
    })
    parentDiv.appendChild(el);
    return parentDiv;
}

function fixFileEmbed(el: Element, source: string): Element {

    let embed = getEmbed(el);
    if(embed === null) {
        return el;
    }

    let alt = embed.getAttr("alt")
    let src = embed.getAttr("src")
    if(src === null) {
        return el;
    }

    let file: TFile = app.metadataCache.getFirstLinkpathDest(src, source);
    if(file === null) {
        return el;
    }
    
    if(isMDExtension(file.extension) === false) {
        return el;
    }

    // If we found the resource path then we update the element to be a proper PDF render.
    let fixedEl = createDiv({
        cls: "internal-embed markdown-embed inline-embed is-loaded",
        attr: {
            "tabindex": "-1",
            "contenteditable": "false"
        }
    })
    fixedEl.setAttr("alt", alt);
    fixedEl.setAttr("src", `app://obsidian.md/${src}`)
    fixedEl.appendChild(createDiv(
        {
            "cls": "embed-title markdown-embed-title",
        }
    ));
    let contentEl = fixedEl.createDiv({
        "cls": `markdown-embed-content`,
    });
    let paragraph = contentEl.createEl("p", {
        "cls": `${MultiColumnStyleCSS.RegionErrorMessage}, ${MultiColumnStyleCSS.SmallFont}`
    });
    paragraph.innerText = "File embeds are not supported in Live Preview.\nPlease use reading mode to view."

    return fixedEl;
}

function fixPDFRender(el: Element, source: string): Element {

    let embed = getEmbed(el);
    if(embed === null) {
        return el;
    }

    let alt = embed.getAttr("alt")
    let src = embed.getAttr("src")
    if(src === null) {
        return el;
    }

    let file: TFile = app.metadataCache.getFirstLinkpathDest(src, source);
    if(file === null) {
        return el;
    }
    
    if(isPDFExtension(file.extension) === false) {
        return el;
    }

    let resourcePath = app.vault.getResourcePath(file);

    // If we found the resource path then we update the element to be a proper PDF render.
    let fixedEl = createDiv({
        cls: "internal-embed pdf-embed is-loaded",
    })
    fixedEl.setAttr("alt", alt);

    let iframe = fixedEl.createEl("iframe", {
        "attr": {
            "style": "width: 100%; height: 100%;"
        }
    });
    iframe.setAttr("src", resourcePath);
    return fixedEl;
}

function fixImageRender(el: Element, source: string): Element {

    let embed = getEmbed(el);
    if(embed === null) {
        return el;
    }

    let customWidth = embed.attributes.getNamedItem("width")
    let alt = embed.getAttr("alt")
    let src = embed.getAttr("src")
    if(src === null) {
        return el;
    }

    let file: TFile = app.metadataCache.getFirstLinkpathDest(src, source);
    if(file === null) {
        return el;
    }
    
    // If the link source is not an image we dont want to make any adjustments.
    if(isImageExtension(file.extension) === false) {
        return el;
    }

    let fixedEl = createDiv({
        cls: "internal-embed image-embed is-loaded",
    })
    fixedEl.setAttr("alt", alt);

    let resourcePath = app.vault.getResourcePath(file);
    let image = fixedEl.createEl("img");
    image.setAttr("src", resourcePath);

    if(customWidth !== null) {
        image.setAttr("width", customWidth.value);
    }

    return fixedEl;
}

function fixExternalLinks(el: Element): Element {

    let items = el.getElementsByClassName("external-link");
    for(let linkEl of Array.from(items)) {

        let link = linkEl as HTMLElement;
        if(link === undefined ||
           link === null ) {
            continue;
        }

        // Remove the href from the link and setup an event listener to open the link in the default browser.
        let href = link.getAttr("href")
        link.removeAttribute("href");

        link.addEventListener("click", (ev) => {

            window.open(href); 
        });
    }

    items = el.getElementsByClassName("internal-link");
    for(let linkEl of Array.from(items)) {

        let link = linkEl as HTMLElement;
        if(link === undefined ||
           link === null ) {
            continue;
        }

        // Removing the href from internal links is all that seems to be required to fix the onclick.
        link.removeAttribute("href");
    }

    return el;
}

function getEmbed(el: Element): Element | null {

    // embeds can either be a <div class="internal-embed" or <p><div class="internal-embed"
    // depending on the syntax this additional check is to fix false negatives when embed is
    // the first case.
    if(el.hasClass("internal-embed")) {
        return el;
    }
    else {

        let items = el.getElementsByClassName("internal-embed");
        if(items.length === 1) {
            return items[0];
        }
    }

    return null;
}

function isImageExtension(extension: string): boolean {

    extension = extension.toLowerCase();
    switch(extension) {
        case "png":
        case "jpg":
        case "jpeg":
        case "gif":
        case "bmp":
        case "svg":
        case "webp":
            return true;
    }
    return false;
}

function isPDFExtension(extension: string): boolean {
    return extension.toLowerCase() === "pdf";
}

function isMDExtension(extension: string): boolean {
    return extension.toLowerCase() === "md";
}

function fixUnSupportedRender(el: Element): Element {

    if(isTasksPlugin(el as HTMLElement)) {
        let fixedEl = createDiv()
        let paragraph = fixedEl.createEl("p", {
            "cls": `${MultiColumnStyleCSS.RegionErrorMessage} ${MultiColumnStyleCSS.SmallFont}`
        });
        paragraph.innerText = "The Tasks plugin is not supported in Live Preview.\nPlease use reading mode."
        return fixedEl;
    }

    return el;
}

function checkForColumnBreakErrors(domObject: DOMObject, workingText: string,
                                   errorManager: RegionErrorManager): string {

    if(domObject.tag !== DOMObjectTag.columnBreak &&
        domObject.elementIsColumnBreak === ElementColumnBreakType.none) {
        return workingText;
    }

    let nextColBreak = checkForParagraphInnerColEndTag(workingText)
    if(nextColBreak === null) {
        console.error("Error. Something went wrong parsing column break out of text.")
        return workingText;
    }

    let startIndex = nextColBreak.index
    let matchLength = nextColBreak[0].length
    let endIndex = startIndex + matchLength
    let matchText = nextColBreak[0].trim();

    let newWorkingText = workingText.slice(endIndex)

    // Already parsed column break warning.
    if(domObject.elementIsColumnBreak !== ElementColumnBreakType.none) {

        parseColBreakErrorType({
            lineAbove: "",
            lineBelow: "",
            objectTag: DOMObjectTag.none,
            colBreakType: domObject.elementIsColumnBreak
        }, errorManager)

        return newWorkingText;
    }

    // Now we have a standard column break but due to changes in obsidian parsing may still 
    // require displaying an error message.
    let endTagText = domObject.originalElement.innerText

    // make sure the element text is a column break just to be sure. This really should never fail.
    if(containsColEndTag(endTagText) === false) {
        // If something went wrong here we can not proceed with the next regex unless this passes.
        console.error("Error parsing column-break tag back out of element text.", endTagText)
        return newWorkingText;
    }

    // make sure the text of the element matche the syntax of what we parsed from the text.
    if(matchText !== endTagText) {
        console.error("Error matching next col-break to current element. Can not continue.")
        return newWorkingText;
    }

    // Slice out the 20 characters before and after the column break and then get just
    // the one line before and after to check if error message required.
    let startIndexOffset = Math.clamp(startIndex - 20, 0, startIndex);
    let endIndexOffset = Math.clamp(endIndex + 20, endIndex, workingText.length - 1);
    
    let additionalText = workingText.slice(startIndexOffset, endIndexOffset);
    let textBefore = additionalText.slice(0, 20);
    let textAfter = additionalText.slice(20 + matchLength)

    let lineAbove = textBefore.split("\n").last()
    let lineBelow = textAfter.split("\n").first()

    parseColBreakErrorType({
        lineAbove: lineAbove,
        lineBelow: lineBelow,
        objectTag: DOMObjectTag.columnBreak,
        colBreakType: ElementColumnBreakType.none
    }, errorManager)

    return newWorkingText
}