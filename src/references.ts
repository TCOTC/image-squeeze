import {
    type App,
    openTab,
} from "siyuan";
import {describeReferences} from "./compress";
import type {ICandidateReference} from "./types";

type TTranslator = (key: string, ...args: string[]) => string;

/** 引用类型的展示文案键；未知类型原样显示内核返回值。 */
const TYPE_LABEL_KEY: Record<string, string> = {
    link: "refTypeLink",
    html: "refTypeHtml",
    attribute: "refTypeAttribute",
    "title-image": "refTypeTitleImage",
    "av-asset": "refTypeAvAsset",
    "av-url": "refTypeAvUrl",
    annotation: "refTypeAnnotation",
    ocr: "refTypeOcr",
};

const escapeHtml = (text: string): string =>
    text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

/** 同一时间只保留一个引用浮窗。 */
let activeLayer: HTMLElement | null = null;
let activeCleanup: (() => void) | null = null;

export const closeReferenceLayer = (): void => {
    if (activeCleanup) {
        activeCleanup();
        activeCleanup = null;
    }
    if (activeLayer) {
        activeLayer.remove();
        activeLayer = null;
    }
};

const positionLayer = (layer: HTMLElement, anchor: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    layer.style.visibility = "hidden";
    document.body.appendChild(layer);
    const width = layer.offsetWidth;
    const height = layer.offsetHeight;
    let left = rect.left - width - margin;
    if (0 > left) {
        left = rect.right + margin;
    }
    if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - width - margin);
    }
    let top = rect.top;
    if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - height - margin);
    }
    layer.style.left = `${Math.round(left)}px`;
    layer.style.top = `${Math.round(top)}px`;
    layer.style.visibility = "";
};

/**
 * 展示某张图片的全部引用位置。
 * 列表项可点击，直接打开对应文档并聚焦到引用所在块。
 */
export const showReferenceLayer = async (options: {
    anchor: HTMLElement;
    references: ICandidateReference[];
    t: TTranslator;
    app: App;
}): Promise<void> => {
    const {anchor, references, t} = options;
    closeReferenceLayer();
    const layer = document.createElement("div");
    layer.className = "isq-refLayer";
    layer.innerHTML = `<div class="isq-refLayer__title">${
        escapeHtml(t("referenceCount", String(references.length)))
    }</div><div class="isq-refLayer__list">${escapeHtml(t("loading"))}</div>`;
    activeLayer = layer;
    positionLayer(layer, anchor);

    const onOutside = (event: MouseEvent) => {
        const target = event.target as Node;
        if (!layer.contains(target) && !anchor.contains(target)) {
            closeReferenceLayer();
        }
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if ("Escape" === event.key) {
            closeReferenceLayer();
        }
    };
    // 延迟注册，避免触发本次点击的同一个事件立刻关闭浮窗
    const timer = window.setTimeout(() => {
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onKeyDown, true);
    }, 0);
    activeCleanup = () => {
        window.clearTimeout(timer);
        document.removeEventListener("mousedown", onOutside, true);
        document.removeEventListener("keydown", onKeyDown, true);
    };

    try {
        await describeReferences(references);
    } catch {
        // 查询失败时退回展示文档内部路径
    }
    if (layer !== activeLayer) {
        return;
    }
    const list = layer.querySelector(".isq-refLayer__list") as HTMLElement;
    list.innerHTML = "";
    for (const item of references) {
        const row = document.createElement("div");
        row.className = "isq-refLayer__item";
        const typeKey = TYPE_LABEL_KEY[item.reference.type];
        const parts = [
            `<div class="isq-refLayer__type">${escapeHtml(typeKey ? t(typeKey) : item.reference.type)}</div>`,
            `<div class="isq-refLayer__path">${
                escapeHtml(item.hPath || item.reference.path || item.reference.blockID)
            }</div>`,
        ];
        if ("" !== item.snippet) {
            parts.push(`<div class="isq-refLayer__snippet">${escapeHtml(item.snippet)}</div>`);
        }
        row.innerHTML = parts.join("");
        if (item.resolvable && "" !== item.reference.blockID) {
            row.classList.add("isq-refLayer__item--clickable");
            row.addEventListener("click", () => {
                openTab({
                    app: options.app,
                    doc: {id: item.reference.blockID, action: ["cb-get-focus"]},
                    keepCursor: true,
                });
                closeReferenceLayer();
            });
        }
        list.appendChild(row);
    }
    // 内容填充后重新定位，避免高度变化导致溢出屏幕
    positionLayer(layer, anchor);
};
