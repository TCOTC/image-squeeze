/**
 * 全屏图片查看。
 *
 * 思源的 `previewImages` 没有暴露给插件 API，但它依赖的 Viewer.js 由内核本地提供
 * （/stage/protyle/js/viewerjs/viewer.js，同 app/src/protyle/preview/image.ts 使用的路径与版本），
 * 因此这里按需加载该脚本并直接使用其全局 Viewer 类，得到与思源一致的缩放、旋转、翻转、
 * 鼠标滚轮缩放、拖拽平移与键盘导航行为。
 *
 * 若脚本加载失败或全局类不可用（例如后续版本调整了路径），则退化为内置的精简浮层，
 * 仍然可以查看与切换前后图片。
 */

type TTranslator = (key: string, ...args: string[]) => string;

export interface IViewerImage {
    /** 图片地址，通常是对象地址。 */
    src: string;
    /** 展示用名称，例如原图或压缩后。 */
    label: string;
}

const SCRIPT_ID = "isqViewerScript";
const SCRIPT_URL = "/stage/protyle/js/viewerjs/viewer.js";

/** Viewer.js 暴露在全局的类；类型按实际使用的成员声明。 */
interface IViewerInstance {
    destroyed: boolean;
    show(): void;
    destroy(): void;
    image: HTMLImageElement;
    toolbar: HTMLElement;
    viewer: HTMLElement;
}

interface IViewerConstructor {
    new(element: HTMLElement, options: Record<string, unknown>): IViewerInstance;
}

const globalViewer = (): IViewerConstructor | undefined => {
    return (window as unknown as {Viewer?: IViewerConstructor;}).Viewer;
};

let loading: Promise<boolean> | null = null;

/** 按需加载 Viewer.js，重复调用共享同一个加载过程。 */
const loadViewerScript = (): Promise<boolean> => {
    if (globalViewer()) {
        return Promise.resolve(true);
    }
    if (loading) {
        return loading;
    }
    loading = new Promise<boolean>((resolve) => {
        const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
        const script = existing || document.createElement("script");
        const finish = (ok: boolean) => {
            if (!ok) {
                // 失败后允许下一次重试
                loading = null;
            }
            resolve(ok);
        };
        script.addEventListener("load", () => finish(undefined !== globalViewer()));
        script.addEventListener("error", () => finish(false));
        if (!existing) {
            script.id = SCRIPT_ID;
            script.src = SCRIPT_URL;
            script.async = false;
            document.head.appendChild(script);
        }
    });
    return loading;
};

let activeViewer: IViewerInstance | null = null;

/** 关闭当前全屏查看；对未打开的情况是空操作。 */
export const closeImageViewer = (): void => {
    const viewer = activeViewer;
    activeViewer = null;
    if (viewer && !viewer.destroyed) {
        viewer.destroy();
    }
};

/** 思源界面语言下的工具栏文案；缺失时退回中性英文。 */
const toolbarLabels = (): Record<string, string> => {
    const languages = (window.siyuan?.languages || {}) as Record<string, string>;
    return {
        "zoom-in": languages.zoomIn || "Zoom in",
        "zoom-out": languages.zoomOut || "Zoom out",
        "one-to-one": languages.pageScaleActual || "Actual size",
        reset: languages.reset || "Reset",
        "rotate-left": languages.rotateCcw || "Rotate left",
        "rotate-right": languages.rotateCw || "Rotate right",
        "flip-horizontal": languages.imageFlipHorizontal || "Flip horizontal",
        "flip-vertical": languages.imageFlipVertical || "Flip vertical",
    };
};

/** 为工具栏按钮补充无障碍标签与思源的图标，保持与内置图片查看一致。 */
const decorateToolbar = (viewer: IViewerInstance): void => {
    for (const [action, label] of Object.entries(toolbarLabels())) {
        const button = viewer.toolbar.querySelector(`.viewer-${action}`);
        if (button) {
            button.classList.add("ariaLabel");
            button.setAttribute("aria-label", label);
            button.setAttribute("data-position", "north");
        }
    }
    // 切换前后图片的左右箭头由 navigation 渲染，位置在工具栏之外
    const languages = (window.siyuan?.languages || {}) as Record<string, string>;
    const arrows: Array<[string, string, string]> = [
        ["prev", languages.previous || "Previous", "#iconLeft"],
        ["next", languages.next || "Next", "#iconRight"],
    ];
    for (const [action, label, icon] of arrows) {
        const button = viewer.viewer.querySelector(`.viewer-navigation > .viewer-${action}`);
        if (!button) {
            continue;
        }
        button.innerHTML = `<svg><use xlink:href="${icon}"></use></svg>`;
        button.classList.add("ariaLabel");
        button.setAttribute("aria-label", label);
        button.setAttribute("data-position", "prev" === action ? "east" : "west");
    }
};

const buildImageList = (images: IViewerImage[]): HTMLUListElement => {
    const list = document.createElement("ul");
    for (const image of images) {
        const item = document.createElement("li");
        const element = document.createElement("img");
        element.src = image.src;
        element.alt = image.label;
        item.appendChild(element);
        list.appendChild(item);
    }
    return list;
};

/** 精简浮层：仅在 Viewer.js 不可用时使用，支持查看与左右切换。 */
const openFallbackViewer = (images: IViewerImage[], index: number, t: TTranslator): void => {
    closeImageViewer();
    let current = Math.max(0, Math.min(images.length - 1, index));
    const layer = document.createElement("div");
    layer.className = "isq-viewer";
    layer.tabIndex = -1;
    const render = () => {
        const image = images[current];
        layer.innerHTML = `<div class="isq-viewer__bar">
    <span class="isq-viewer__label">${image.label}</span>
    <span class="isq-viewer__index">${current + 1} / ${images.length}</span>
    <button class="b3-button b3-button--outline isq-viewer__prev">${t("prev")}</button>
    <button class="b3-button b3-button--outline isq-viewer__next">${t("next")}</button>
    <button class="b3-button b3-button--outline isq-viewer__close">${t("close")}</button>
</div>
<div class="isq-viewer__stage"><img src="${image.src}" alt=""></div>`;
        const prev = layer.querySelector(".isq-viewer__prev") as HTMLButtonElement;
        const next = layer.querySelector(".isq-viewer__next") as HTMLButtonElement;
        prev.disabled = 1 >= images.length;
        next.disabled = 1 >= images.length;
        prev.addEventListener("click", (event) => {
            event.stopPropagation();
            current = (current - 1 + images.length) % images.length;
            render();
        });
        next.addEventListener("click", (event) => {
            event.stopPropagation();
            current = (current + 1) % images.length;
            render();
        });
        layer.querySelector(".isq-viewer__close")?.addEventListener("click", (event) => {
            event.stopPropagation();
            close();
        });
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if ("Escape" === event.key) {
            close();
        } else if ("ArrowLeft" === event.key) {
            current = (current - 1 + images.length) % images.length;
            render();
        } else if ("ArrowRight" === event.key) {
            current = (current + 1) % images.length;
            render();
        }
    };
    const close = () => {
        document.removeEventListener("keydown", onKeyDown, true);
        layer.remove();
        if (fallbackLayer === layer) {
            fallbackLayer = null;
        }
    };
    layer.addEventListener("click", (event) => {
        if (event.target === layer) {
            close();
        }
    });
    render();
    document.body.appendChild(layer);
    fallbackLayer = layer;
    layer.focus();
    document.addEventListener("keydown", onKeyDown, true);
};

let fallbackLayer: HTMLElement | null = null;

/**
 * 打开全屏查看。`images` 传入前后两张即可用左右方向键或箭头按钮对比。
 */
export const openImageViewer = async (options: {
    images: IViewerImage[];
    index: number;
    t: TTranslator;
}): Promise<void> => {
    const {images, t} = options;
    if (0 === images.length) {
        return;
    }
    const ready = await loadViewerScript();
    const ViewerClass = globalViewer();
    if (!ready || !ViewerClass) {
        openFallbackViewer(images, options.index, t);
        return;
    }
    closeImageViewer();
    const list = buildImageList(images);
    const index = Math.max(0, Math.min(images.length - 1, options.index));
    let cleaned = false;
    let viewer: IViewerInstance | null = null;
    const close = () => {
        // Viewer 的 destroy 会再次触发 hidden，用标记避免递归
        if (cleaned) {
            return;
        }
        cleaned = true;
        if (viewer && !viewer.destroyed) {
            viewer.destroy();
        }
        if (activeViewer === viewer) {
            activeViewer = null;
        }
    };
    viewer = new ViewerClass(list, {
        initialViewIndex: index,
        title: [1, (image: HTMLImageElement, imageData: {naturalWidth: number; naturalHeight: number;}) => {
            const label = image.alt || "";
            return `${label} [${imageData.naturalWidth} × ${imageData.naturalHeight}]`;
        }],
        button: false,
        magnifier: true,
        navigation: 1 < images.length,
        transition: false,
        toolbar: {
            zoomIn: true,
            zoomOut: true,
            oneToOne: true,
            reset: true,
            rotateLeft: true,
            rotateRight: true,
            flipHorizontal: true,
            flipVertical: true,
            prev: false,
            next: false,
            play: false,
        },
        ready: () => {
            if (viewer) {
                decorateToolbar(viewer);
            }
        },
        viewed: () => {
            if (viewer) {
                decorateToolbar(viewer);
            }
        },
        hidden: close,
    });
    activeViewer = viewer;
    // 移动端的返回操作依赖该引用关闭浮层，与思源自带查看器保持一致
    (window.siyuan as unknown as {viewer?: IViewerInstance;}).viewer = viewer;
    viewer.show();
};
