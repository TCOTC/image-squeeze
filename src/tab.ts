import {
    type App,
    showMessage,
} from "siyuan";
import {CodecPool} from "./codec/pool";
import {
    applyAccepted,
    checkEncoded,
    emptySummary,
    encodeCandidate,
    listCandidatePaths,
    analyzeCandidates,
    releasePreview,
    runBatch,
    uploadCandidate,
    writeInPlace,
} from "./compress";
import {
    closeReferenceLayer,
    showReferenceLayer,
} from "./references";
import type {
    ICandidate,
    ICandidateReference,
    ICompressOptions,
    ICompressSummary,
    TEncodeMode,
    IUnavailableAttributeView,
} from "./types";
import {
    closeImageViewer,
    openImageViewer,
    type IViewerImage,
} from "./viewer";

export type TTranslator = (key: string, ...args: string[]) => string;

const escapeHtml = (text: string): string =>
    text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const formatBytes = (bytes: number): string => {
    if (1 > bytes) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (1024 <= value && index < units.length - 1) {
        value /= 1024;
        index++;
    }
    return `${1 === index ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
};

const STATUS_LABEL_KEY: Record<string, string> = {
    pending: "statusPending",
    encoding: "statusEncoding",
    uploading: "statusUploading",
    done: "statusDone",
    skipped: "statusSkipped",
    failed: "statusFailed",
};

const UNAVAILABLE_REASON_KEY: Record<string, string> = {
    missing_definition: "reasonMissingDefinition",
    invalid_id: "reasonInvalidId",
};

/** 列表筛选维度。 */
type TFilter = "all" | "referenced" | "unreferenced";

export interface ISqueezeTabHooks {
    app: App;
    t: TTranslator;
}

/**
 * 图片压缩页签。负责配置、扫描、列表、逐张对比确认与结果展示。
 * 相册编码、引用改写等链路委托给 compress 模块，本类只处理交互。
 */
export class SqueezeTab {
    private readonly t: TTranslator;
    private readonly app: App;
    private readonly pluginName: string;
    private readonly root: HTMLElement;
    private readonly rows = new Map<string, HTMLElement>();
    private candidates: ICandidate[] = [];
    private visible: ICandidate[] = [];
    private references = new Map<string, ICandidateReference[]>();
    private unavailableViews: IUnavailableAttributeView[] = [];
    private filter: TFilter = "all";
    private keyword = "";
    private running = false;
    private aborted = false;
    private scanned = false;
    private reviewMode = false;
    private reviewQueue: ICandidate[] = [];
    private reviewIndex = 0;
    private reviewPool: CodecPool | null = null;
    /** 逐张确认时已编码但尚未上传的结果，避免重复读取与重复编码。 */
    private readonly reviewBuffers = new Map<string, ArrayBuffer>();
    private reviewBusy = false;
    private summary: ICompressSummary = emptySummary();

    constructor(options: {element: Element; app: App; t: TTranslator; pluginName: string;}) {
        this.t = options.t;
        this.app = options.app;
        this.pluginName = options.pluginName;
        this.root = options.element as HTMLElement;
        this.root.classList.add("isq-host");
        this.root.innerHTML = this.template();
        this.bind();
        this.syncModeControls();
    }

    public destroy(): void {
        this.aborted = true;
        this.closeReviewPool();
        closeReferenceLayer();
        closeImageViewer();
        for (const candidate of this.candidates) {
            releasePreview(candidate);
        }
        this.root.classList.remove("isq-host");
        this.root.innerHTML = "";
    }

    public resize(): void {
        // 布局由 CSS 自适应，无需额外处理
    }

    private template(): string {
        return `<div class="isq">
    <div class="isq__toolbar">
        <select class="b3-select isq__mode">
            <option value="optimize" selected>${this.t("modeOptimize")}</option>
            <option value="webp">${this.t("modeWebp")}</option>
        </select>
        <span class="isq__label isq-toggle-webp">${this.t("quality")}</span>
        <select class="b3-select isq__quality isq-toggle-webp">
            <option value="90" selected>${this.t("qualityLossless")}</option>
            <option value="80">${this.t("qualityBalanced")}</option>
            <option value="60">${this.t("qualitySmallest")}</option>
        </select>
        <label class="isq__check isq-toggle-webp" title="${this.t("losslessTip")}">
            <input class="b3-switch isq__lossless" type="checkbox">${this.t("lossless")}
        </label>
        <span class="isq__label isq-toggle-webp">${this.t("method")}</span>
        <input class="b3-text-field isq-toggle-webp isq__method" type="number" value="4" min="0" max="6" step="1" title="${
            this.t("methodTip")
        }">
        <label class="isq__check isq-toggle-webp" title="${this.t("verifyTip")}">
            <input class="b3-switch isq__verify" type="checkbox" checked>${this.t("verify")}
        </label>
        <label class="isq__check isq-toggle-webp" title="${this.t("deleteUnreferencedTip")}">
            <input class="b3-switch isq__delete" type="checkbox" checked>${this.t("deleteUnreferenced")}
        </label>
        <span class="isq__label">${this.t("maxDimension")}</span>
        <input class="b3-text-field isq__maxdim" type="number" value="0" min="0" step="100" title="${
            this.t("maxDimensionTip")
        }">
        <span class="isq__label isq-toggle-optimize">${this.t("quality")}</span>
        <select class="b3-select isq__optQuality isq-toggle-optimize" title="${this.t("mozjpegQualityTip")}">
            <option value="90" selected>${this.t("qualityLossless")}</option>
            <option value="80">${this.t("qualityBalanced")}</option>
            <option value="60">${this.t("qualitySmallest")}</option>
        </select>
        <span class="isq__label isq-toggle-optimize">${this.t("oxipngLevel")}</span>
        <input class="b3-text-field isq-toggle-optimize isq__oxilevel" type="number" value="2" min="1" max="6" step="1" title="${
            this.t("oxipngLevelTip")
        }">
        <label class="isq__check isq-toggle-optimize" title="${this.t("progressiveTip")}">
            <input class="b3-switch isq__progressive" type="checkbox" checked>${this.t("progressive")}
        </label>
        <span class="isq__label">${this.t("minSaving")}</span>
        <input class="b3-text-field isq__minsaving" type="number" value="5" min="0" max="90" step="1">
    </div>
    <div class="isq__actions">
        <button class="b3-button b3-button--outline isq__scan">${this.t("scan")}</button>
        <select class="b3-select isq__filter">
            <option value="all" selected>${this.t("filterAll")}</option>
            <option value="referenced">${this.t("filterReferenced")}</option>
            <option value="unreferenced">${this.t("filterUnreferenced")}</option>
        </select>
        <input class="b3-text-field isq__search" placeholder="${this.t("searchPlaceholder")}">
        <button class="b3-button b3-button--outline isq__all">${this.t("selectAllShown")}</button>
        <button class="b3-button b3-button--outline isq__none">${this.t("selectNone")}</button>
        <button class="b3-button b3-button--outline isq__invert">${this.t("invertSelection")}</button>
        <button class="b3-button isq__reviewStart">${this.t("reviewStart")}</button>
        <button class="b3-button b3-button--outline isq__run">${this.t("runBatch")}</button>
        <button class="b3-button b3-button--cancel isq__stop fn__none">${this.t("stop")}</button>
    </div>
    <div class="isq__progress fn__none"></div>
    <div class="isq__warn fn__none"></div>
    <div class="isq__body">
        <div class="isq__list"><div class="isq__empty">${this.t("notScanned")}</div></div>
        <div class="isq__review fn__none"></div>
    </div>
    <div class="isq__footer"></div>
</div>`;
    }

    private query<T extends HTMLElement>(selector: string): T {
        return this.root.querySelector(selector) as T;
    }

    /**
     * 对比区域容器。选择器限定在 isq__body 的子元素上：
     * 工具栏的启动按钮与容器曾共用 isq__review 类名，
     * 而 querySelector 只返回第一个匹配项，会导致内容被写进按钮里。
     */
    private get reviewBody(): HTMLElement {
        return this.query(".isq__body > .isq__review");
    }

    private bind(): void {
        this.query(".isq__scan").addEventListener("click", () => {
            void this.scan();
        });
        this.query(".isq__all").addEventListener("click", () => {
            this.applySelection(() => true);
        });
        this.query(".isq__none").addEventListener("click", () => {
            this.applySelection(() => false);
        });
        this.query(".isq__invert").addEventListener("click", () => {
            this.applySelection((candidate) => !candidate.selected);
        });
        this.query(".isq__run").addEventListener("click", () => {
            void this.startBatch();
        });
        this.query(".isq__reviewStart").addEventListener("click", () => {
            void this.startReview();
        });
        this.query(".isq__stop").addEventListener("click", () => {
            this.aborted = true;
        });
        this.query(".isq__filter").addEventListener("change", (event) => {
            this.filter = (event.target as HTMLSelectElement).value as TFilter;
            this.renderList();
        });
        this.query(".isq__mode").addEventListener("change", () => {
            this.syncModeControls();
        });
        this.query(".isq__search").addEventListener("input", (event) => {
            this.keyword = (event.target as HTMLInputElement).value.trim().toLowerCase();
            this.renderList();
        });
        this.query(".isq__list").addEventListener("change", (event) => {
            const target = event.target as HTMLInputElement;
            if (!target.classList.contains("isq__pick")) {
                return;
            }
            const candidate = this.findCandidate(target.getAttribute("data-path") || "");
            if (candidate) {
                candidate.selected = target.checked;
                this.updateRow(candidate);
                this.renderFooter();
            }
        });
        this.query(".isq__list").addEventListener("click", (event) => {
            const target = (event.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
            if (!target || this.running) {
                return;
            }
            const candidate = this.findCandidate(target.getAttribute("data-path") || "");
            if (!candidate) {
                return;
            }
            if ("references" === target.getAttribute("data-action")) {
                void this.openReferences(candidate, target);
            } else if ("review" === target.getAttribute("data-action")) {
                this.reviewQueue = [candidate];
                this.reviewIndex = 0;
                this.enterReview();
            }
        });
    }

    private findCandidate(path: string): ICandidate | undefined {
        return this.candidates.find((item) => item.path === path);
    }

    private clamped(input: string, min: number, max: number, fallback: number): number {
        const value = Number(input);
        if (!Number.isFinite(value)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, value));
    }

    private options(): ICompressOptions {
        const mode = this.query<HTMLSelectElement>(".isq__mode").value as TEncodeMode;
        // 两种模式各自的质量档位：转 WebP 与 mozjpeg 重编码的质量互不影响
        const qualitySource = "webp" === mode ?
            this.query<HTMLSelectElement>(".isq__quality").value :
            this.query<HTMLSelectElement>(".isq__optQuality").value;
        const maxDimension = Number(this.query<HTMLInputElement>(".isq__maxdim").value);
        const minSaving = Number(this.query<HTMLInputElement>(".isq__minsaving").value);
        return {
            mode,
            quality: this.clamped(qualitySource, 1, 100, 80),
            lossless: this.query<HTMLInputElement>(".isq__lossless").checked,
            method: this.clamped(this.query<HTMLInputElement>(".isq__method").value, 0, 6, 4),
            oxipngLevel: this.clamped(this.query<HTMLInputElement>(".isq__oxilevel").value, 1, 6, 2),
            progressive: this.query<HTMLInputElement>(".isq__progressive").checked,
            maxDimension: Number.isFinite(maxDimension) && 0 < maxDimension ? maxDimension : 0,
            minSavingRatio: Number.isFinite(minSaving) ? Math.min(0.9, Math.max(0, minSaving / 100)) : 0.05,
            verify: this.query<HTMLInputElement>(".isq__verify").checked,
            deleteUnreferenced: this.query<HTMLInputElement>(".isq__delete").checked,
        };
    }

    /** 按当前模式显示对应的选项控件；质量档位在两种模式间保持独立。 */
    private syncModeControls(): void {
        const webp = "webp" === this.query<HTMLSelectElement>(".isq__mode").value;
        for (const element of this.root.querySelectorAll<HTMLElement>(".isq-toggle-webp")) {
            element.classList.toggle("fn__none", !webp);
        }
        for (const element of this.root.querySelectorAll<HTMLElement>(".isq-toggle-optimize")) {
            element.classList.toggle("fn__none", webp);
        }
        // 缩放上限只在转 WebP 时生效，因为原格式优化不会改变尺寸
        this.query(".isq__maxdim").toggleAttribute("disabled", !webp);
    }

    private setBusy(busy: boolean): void {
        this.running = busy;
        this.query(".isq__stop").classList.toggle("fn__none", !busy);
        for (const selector of [".isq__scan", ".isq__run", ".isq__reviewStart"]) {
            this.query(selector).classList.toggle("fn__none", busy);
        }
        for (
            const selector of [
                ".isq__quality",
                ".isq__optQuality",
                ".isq__mode",
                ".isq__maxdim",
                ".isq__minsaving",
                ".isq__lossless",
                ".isq__method",
                ".isq__oxilevel",
                ".isq__progressive",
                ".isq__verify",
                ".isq__delete",
                ".isq__filter",
                ".isq__search",
                ".isq__all",
                ".isq__none",
                ".isq__invert",
            ]
        ) {
            this.query(selector).toggleAttribute("disabled", busy);
        }
        // 运行期间锁定勾选，避免进度回填把用户的勾选状态覆盖掉
        for (const checkbox of this.root.querySelectorAll<HTMLInputElement>(".isq__pick")) {
            checkbox.disabled = busy || "false" === checkbox.getAttribute("data-selectable");
        }
    }

    private setProgress(text: string): void {
        const element = this.query(".isq__progress");
        element.classList.remove("fn__none");
        element.textContent = text;
    }

    private applySelection(decide: (candidate: ICandidate) => boolean): void {
        for (const candidate of this.visible) {
            if (!this.selectable(candidate)) {
                continue;
            }
            candidate.selected = decide(candidate);
        }
        this.renderList();
        this.renderFooter();
    }

    /** 只有可被处理的候选允许勾选；不可重链的被引用资源与已结束的项均不可选。 */
    private selectable(candidate: ICandidate): boolean {
        if (candidate.referenced && !candidate.relinkable) {
            return false;
        }
        return "pending" === candidate.status || "encoding" === candidate.status ||
            "uploading" === candidate.status;
    }

    private async scan(): Promise<void> {
        if (this.running) {
            return;
        }
        this.setBusy(true);
        this.setProgress(this.t("scanning"));
        this.unavailableViews = [];
        this.renderUnavailable();
        try {
            const paths = await listCandidatePaths();
            this.setProgress(this.t("analyzing", String(paths.length)));
            const analyzed = await analyzeCandidates(paths);
            for (const candidate of this.candidates) {
                releasePreview(candidate);
            }
            this.candidates = analyzed.candidates;
            this.references = analyzed.references;
            this.unavailableViews = analyzed.unavailableViews;
            this.scanned = true;
            this.renderList();
            this.renderUnavailable();
            this.renderFooter();
            this.setProgress(
                0 === this.candidates.length ?
                    this.t("noCandidates") :
                    this.t("scanned", String(this.candidates.length)),
            );
        } catch (error) {
            showMessage(`${this.t("title")}: ${error instanceof Error ? error.message : String(error)}`);
            this.setProgress(this.t("scanFailed"));
        } finally {
            this.setBusy(false);
        }
    }

    private filtered(): ICandidate[] {
        return this.candidates.filter((candidate) => {
            if ("referenced" === this.filter && !candidate.referenced) {
                return false;
            }
            if ("unreferenced" === this.filter && candidate.referenced) {
                return false;
            }
            if ("" !== this.keyword && !candidate.path.toLowerCase().includes(this.keyword)) {
                return false;
            }
            return true;
        });
    }

    private renderList(): void {
        const list = this.query(".isq__list");
        this.rows.clear();
        if (0 === this.candidates.length) {
            list.innerHTML = `<div class="isq__empty">${
                this.scanned ? this.t("noCandidates") : this.t("notScanned")
            }</div>`;
            return;
        }
        this.visible = this.filtered();
        if (0 === this.visible.length) {
            list.innerHTML = `<div class="isq__empty">${this.t("noMatch")}</div>`;
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const candidate of this.visible) {
            const row = document.createElement("div");
            row.className = "isq__row";
            const selectable = this.selectable(candidate);
            row.innerHTML = `<input class="b3-switch isq__pick" type="checkbox" data-path="${
                escapeHtml(candidate.path)
            }" data-selectable="${selectable}"${candidate.selected ? " checked" : ""}${selectable ? "" : " disabled"}>
<span class="isq__name" title="${escapeHtml(candidate.path)}">${escapeHtml(candidate.path)}</span>
<span class="isq__meta"></span>
<span class="isq__actionsCell">
    <button class="b3-button b3-button--text isq__rowBtn" data-action="references" data-path="${
                escapeHtml(candidate.path)
            }">${this.t("showReferences")}</button>
    <button class="b3-button b3-button--text isq__rowBtn" data-action="review" data-path="${
                escapeHtml(candidate.path)
            }">${this.t("reviewOne")}</button>
</span>
<span class="isq__status"></span>`;
            this.rows.set(candidate.path, row);
            fragment.appendChild(row);
            this.updateRow(candidate);
        }
        list.innerHTML = "";
        list.appendChild(fragment);
    }

    private updateRow(candidate: ICandidate): void {
        const row = this.rows.get(candidate.path);
        if (!row) {
            return;
        }
        const meta = row.querySelector(".isq__meta") as HTMLElement;
        meta.classList.remove("isq__meta--grew");
        if (0 < candidate.outputSize && 0 < candidate.sourceSize) {
            const percent = Math.round(candidate.savingRatio * 100);
            // 负收益需要显式标注，否则 -48% 会被误读成节省了 48%
            const saving = 0 <= percent ? `${percent}%` : this.t("grewShort", String(-percent));
            meta.textContent = `${formatBytes(candidate.sourceSize)} → ${
                formatBytes(candidate.outputSize)
            } (${saving})`;
            meta.classList.toggle("isq__meta--grew", 0 > percent);
        } else {
            meta.textContent = candidate.referenced ?
                `${candidate.refCount} ${this.t("refs")}` :
                this.t("unreferenced");
        }
        const status = row.querySelector(".isq__status") as HTMLElement;
        status.textContent = this.statusText(candidate);
        status.setAttribute("data-state", candidate.status);
        row.setAttribute("data-state", candidate.status);
        (row.querySelector(".isq__pick") as HTMLInputElement).checked = candidate.selected;
        const refButton = row.querySelector('[data-action="references"]') as HTMLButtonElement;
        refButton.classList.toggle("fn__none", !candidate.referenced);
    }

    /** message 优先作为文案键翻译；翻译缺失时原样展示，便于暴露内核返回的原始原因。 */
    private statusText(candidate: ICandidate): string {
        if (candidate.message) {
            const translated = this.t(candidate.message);
            return translated === candidate.message ? candidate.message : translated;
        }
        return this.t(STATUS_LABEL_KEY[candidate.status] || "statusPending");
    }

    private async openReferences(candidate: ICandidate, anchor: HTMLElement): Promise<void> {
        const list = this.references.get(candidate.path) || [];
        if (0 === list.length) {
            showMessage(this.t("noReferences"));
            return;
        }
        await showReferenceLayer({anchor, references: list, t: this.t, app: this.app});
    }

    /** 全屏查看当前候选的原图与压缩结果，按点击的那张作为初始图。 */
    private openFullscreen(candidate: ICandidate, index: number): void {
        const images: IViewerImage[] = [];
        let initial = 0;
        if ("" !== candidate.sourceURL) {
            images.push({src: candidate.sourceURL, label: this.t("before")});
        }
        if ("" !== candidate.previewURL) {
            if (1 === index) {
                initial = images.length;
            }
            images.push({src: candidate.previewURL, label: this.t("after")});
        }
        if (0 === images.length) {
            return;
        }
        void openImageViewer({images, index: initial, t: this.t});
    }

    private renderUnavailable(): void {
        const element = this.query(".isq__warn");
        if (0 === this.unavailableViews.length) {
            element.classList.add("fn__none");
            element.innerHTML = "";
            return;
        }
        const items = this.unavailableViews.map((view) => {
            const notebook = view.notebookName || view.notebook;
            const location = [notebook, view.hPath || view.path].filter((part) => "" !== part).join(" - ");
            const reasonKey = UNAVAILABLE_REASON_KEY[view.reason];
            const reason = reasonKey ? this.t(reasonKey) : view.reason;
            return `<div class="isq__warnItem" title="${escapeHtml(view.avID)}">${
                escapeHtml(this.t("unavailableViewItem", reason, location))
            }</div>`;
        }).join("");
        element.innerHTML = `<details>
<summary>${escapeHtml(this.t("unavailableViews", String(this.unavailableViews.length)))}</summary>
<div class="isq__warnList">${items}</div>
</details>`;
        element.classList.remove("fn__none");
    }

    private renderFooter(): void {
        if (0 === this.candidates.length) {
            this.query(".isq__footer").innerHTML = "";
            return;
        }
        const selected = this.candidates.filter((candidate) => candidate.selected).length;
        const referenced = this.candidates.filter((candidate) => candidate.referenced).length;
        this.query(".isq__footer").innerHTML = `<div class="isq__footerItem">${
            escapeHtml(this.t("footerStats", String(selected), String(this.candidates.length), String(referenced)))
        }</div>`;
    }

    private renderSummary(summary: ICompressSummary): void {
        const parts = [
            this.t(
                "summaryConverted",
                String(summary.converted),
                String(summary.skipped),
                String(summary.failed),
            ),
        ];
        if (0 < summary.deleted) {
            parts.push(this.t("summaryDeleted", String(summary.deleted)));
        }
        if (0 < summary.sourceSize) {
            const saving = Math.round((1 - summary.outputSize / summary.sourceSize) * 100);
            parts.push(`${formatBytes(summary.sourceSize)} → ${formatBytes(summary.outputSize)} (${saving}%)`);
        }
        parts.push(this.t("cleanupHint"));
        if (0 < summary.orphans) {
            parts.push(this.t("orphanHint", String(summary.orphans)));
        }
        if (0 < summary.leftovers.length) {
            parts.push(this.t("leftovers", String(summary.leftovers.length)));
        }
        this.query(".isq__footer").innerHTML = parts
            .map((part) => `<div class="isq__footerItem">${escapeHtml(part)}</div>`)
            .join("");
    }

    // ---- 批量处理 ----

    private async startBatch(): Promise<void> {
        const targets = this.candidates.filter((candidate) => candidate.selected);
        if (0 === targets.length) {
            showMessage(this.t("nothingSelected"));
            return;
        }
        this.aborted = false;
        this.setBusy(true);
        const pool = new CodecPool(this.pluginName, 2);
        try {
            // 按候选的终态数量统计，避免同一候选被多次上报时重复计数
            const countFinished = (): number =>
                targets.filter((candidate) =>
                    "pending" !== candidate.status && "encoding" !== candidate.status &&
                    "uploading" !== candidate.status
                ).length;
            const summary = await runBatch(targets, this.options(), pool, (candidate) => {
                this.updateRow(candidate);
                this.setProgress(this.t("processing", String(countFinished()), String(targets.length)));
            }, () => this.aborted);
            this.summary = summary;
            this.renderSummary(summary);
            this.setProgress(summary.aborted ? this.t("aborted") : this.t("finished"));
        } catch (error) {
            showMessage(`${this.t("title")}: ${error instanceof Error ? error.message : String(error)}`);
            this.setProgress(this.t("runFailed"));
        } finally {
            pool.close();
            this.setBusy(false);
        }
    }

    // ---- 逐张确认 ----

    private enterReview(): void {
        this.reviewMode = true;
        // 清除上一轮应用阶段留下的锁定状态，否则本轮按钮不可点击
        this.reviewBody.classList.remove("isq-review--busy");
        this.query(".isq__list").classList.add("fn__none");
        this.reviewBody.classList.remove("fn__none");
        this.query(".isq__actions").classList.add("fn__none");
        void this.renderReview();
    }

    private exitReview(): void {
        this.reviewMode = false;
        this.closeReviewPool();
        this.reviewBody.classList.add("fn__none");
        this.reviewBody.innerHTML = "";
        this.query(".isq__list").classList.remove("fn__none");
        this.query(".isq__actions").classList.remove("fn__none");
        this.renderList();
        this.renderFooter();
    }

    private closeReviewPool(): void {
        if (this.reviewPool) {
            this.reviewPool.close();
            this.reviewPool = null;
        }
        this.reviewBuffers.clear();
    }

    private async startReview(): Promise<void> {
        if (this.running || this.reviewMode) {
            return;
        }
        const targets = this.candidates.filter((candidate) => candidate.selected);
        if (0 === targets.length) {
            showMessage(this.t("nothingSelected"));
            return;
        }
        this.reviewQueue = targets;
        this.reviewIndex = 0;
        this.enterReview();
    }

    private currentReview(): ICandidate | undefined {
        return this.reviewQueue[this.reviewIndex];
    }

    private async renderReview(): Promise<void> {
        const container = this.reviewBody;
        const candidate = this.currentReview();
        if (!candidate) {
            container.innerHTML = `<div class="isq__empty">${this.t("reviewDone")}</div>
<div class="isq-review__actions">
    <button class="b3-button isq-review__finish">${this.t("reviewApply")}</button>
    <button class="b3-button b3-button--outline isq-review__back">${this.t("backToList")}</button>
</div>`;
            container.querySelector(".isq-review__finish")?.addEventListener("click", () => {
                void this.finishReview();
            });
            container.querySelector(".isq-review__back")?.addEventListener("click", () => {
                this.exitReview();
            });
            return;
        }
        container.innerHTML = `<div class="isq-review">
    <div class="isq-review__head">
        <span class="isq-review__index">${
            escapeHtml(this.t("reviewIndex", String(this.reviewIndex + 1), String(this.reviewQueue.length)))
        }</span>
        <span class="isq-review__path" title="${escapeHtml(candidate.path)}">${escapeHtml(candidate.path)}</span>
        <button class="b3-button b3-button--text isq-review__refs"${candidate.referenced ? "" : " disabled"}>${
            this.t("showReferences")
        }</button>
    </div>
    <div class="isq-review__panes">
        <div class="isq-review__pane">
            <div class="isq-review__label">${this.t("before")}</div>
            <div class="isq-review__stage${
            candidate.sourceURL ? " isq-review__stage--clickable" : ""
        }" data-view="source" title="${this.t("zoomHint")}">${
            candidate.sourceURL ? `<img src="${candidate.sourceURL}" alt="${escapeHtml(this.t("before"))}">` : ""
        }</div>
            <div class="isq-review__size"></div>
        </div>
        <div class="isq-review__pane">
            <div class="isq-review__label">${this.t("after")}</div>
            <div class="isq-review__stage${
            candidate.previewURL ? " isq-review__stage--clickable" : ""
        }" data-view="preview" title="${this.t("zoomHint")}">${
            candidate.previewURL ? `<img src="${candidate.previewURL}" alt="${escapeHtml(this.t("after"))}">` : ""
        }</div>
            <div class="isq-review__size"></div>
        </div>
    </div>
    <div class="isq-review__meta"></div>
    <div class="isq-review__notice"></div>
    <div class="isq-review__actions">
        <button class="b3-button b3-button--outline isq-review__prev">${this.t("prev")}</button>
        <button class="b3-button b3-button--outline isq-review__skip">${this.t("skip")}</button>
        <button class="b3-button isq-review__accept">${this.t("accept")}</button>
        <button class="b3-button b3-button--outline isq-review__next">${this.t("next")}</button>
        <button class="b3-button isq-review__close">${this.t("reviewApply")}</button>
        <button class="b3-button b3-button--outline isq-review__back">${this.t("backToList")}</button>
    </div>
</div>`;

        const prev = container.querySelector(".isq-review__prev") as HTMLButtonElement;
        const next = container.querySelector(".isq-review__next") as HTMLButtonElement;
        const skip = container.querySelector(".isq-review__skip") as HTMLButtonElement;
        const accept = container.querySelector(".isq-review__accept") as HTMLButtonElement;
        prev.disabled = 0 >= this.reviewIndex || this.reviewBusy;
        next.disabled = this.reviewIndex >= this.reviewQueue.length - 1 || this.reviewBusy;
        skip.disabled = this.reviewBusy;
        // 采用按钮的禁用状态由 updateReviewInfo 统一设置，避免两处规则不一致
        accept.disabled = this.reviewBusy;
        for (const [selector, delta] of [[".isq-review__prev", -1], [".isq-review__next", 1]] as const) {
            container.querySelector(selector)?.addEventListener("click", () => {
                this.reviewIndex = Math.max(0, Math.min(this.reviewQueue.length - 1, this.reviewIndex + delta));
                void this.renderReview();
            });
        }
        container.querySelector(".isq-review__skip")?.addEventListener("click", () => {
            candidate.decision = "rejected";
            candidate.status = "skipped";
            candidate.message = "userSkipped";
            void this.renderReview();
        });
        container.querySelector(".isq-review__accept")?.addEventListener("click", () => {
            void this.acceptReview(candidate);
        });
        container.querySelector(".isq-review__close")?.addEventListener("click", () => {
            void this.finishReview();
        });
        container.querySelector(".isq-review__back")?.addEventListener("click", () => {
            this.exitReview();
        });
        container.querySelector(".isq-review__refs")?.addEventListener("click", (event) => {
            void this.openReferences(candidate, event.target as HTMLElement);
        });
        // 点击任一张图片即可全屏查看，并在全屏中用左右方向键对比前后
        for (const stage of container.querySelectorAll<HTMLElement>(".isq-review__stage")) {
            stage.addEventListener("click", () => {
                this.openFullscreen(candidate, "preview" === stage.getAttribute("data-view") ? 1 : 0);
            });
        }

        this.updateReviewInfo(container, candidate);
        if ("" === candidate.previewURL && "pending" === candidate.status) {
            await this.encodeReview(candidate);
        }
    }

    private updateReviewInfo(container: HTMLElement, candidate: ICandidate): void {
        const sizes = container.querySelectorAll(".isq-review__size");
        if (2 <= sizes.length) {
            (sizes[0] as HTMLElement).textContent = 0 < candidate.sourceSize ? formatBytes(candidate.sourceSize) : "";
            (sizes[1] as HTMLElement).textContent = 0 < candidate.outputSize ? formatBytes(candidate.outputSize) : "";
        }
        const meta = container.querySelector(".isq-review__meta") as HTMLElement;
        const bits: string[] = [];
        if (0 < candidate.outputWidth) {
            bits.push(`${candidate.outputWidth}×${candidate.outputHeight}`);
        }
        if (0 < candidate.outputSize) {
            // 负值表示压缩后反而变大，需明确标注，避免被当成正常节省
            const percent = Math.round(candidate.savingRatio * 100);
            bits.push(0 <= percent ? this.t("savingLabel", String(percent)) : this.t("grewLabel", String(-percent)));
        }
        if (candidate.message) {
            const translated = this.t(candidate.message);
            bits.push(translated === candidate.message ? candidate.message : translated);
        }
        meta.textContent = bits.join(" · ");
        const notice = container.querySelector(".isq-review__notice") as HTMLElement;
        const notWorthwhile = "not_worthwhile" === candidate.message;
        if (notWorthwhile) {
            notice.textContent = this.t("noticeNotWorthwhile");
        } else {
            notice.textContent = candidate.referenced ?
                this.t("noticeReferenced", String(candidate.refCount)) :
                this.t("noticeUnreferenced");
        }
        notice.classList.toggle("isq-review__notice--danger", notWorthwhile || !candidate.referenced);
        const acceptButton = container.querySelector(".isq-review__accept") as HTMLButtonElement;
        acceptButton.textContent = "done" === candidate.status ? this.t("accepted") : this.t("accept");
        // 收益不足或编码失败时不允许采用，否则会把笔记变得更大或写入无效结果
        acceptButton.disabled = "pending" !== candidate.status && "done" !== candidate.status;
    }

    private async encodeReview(candidate: ICandidate): Promise<void> {
        this.reviewBusy = true;
        const container = this.reviewBody;
        const meta = container.querySelector(".isq-review__meta") as HTMLElement | null;
        if (meta) {
            meta.textContent = this.t("statusEncoding");
        }
        try {
            if (!this.reviewPool) {
                this.reviewPool = new CodecPool(this.pluginName, 1);
            }
            const buffer = await encodeCandidate(candidate, this.options(), this.reviewPool);
            // 编码完成但尚未上传，回到待决定状态
            candidate.status = "pending";
            candidate.message = "";
            // 与批量处理共用同一判断：体积反而变大或收益不足时不建议替换
            const skipReason = checkEncoded(candidate, this.options());
            if (skipReason) {
                candidate.status = "skipped";
                candidate.message = skipReason;
                // 不会采用，直接释放编码结果，避免占用内存
                this.reviewBuffers.delete(candidate.path);
            } else {
                this.reviewBuffers.set(candidate.path, buffer);
            }
        } catch (error) {
            candidate.status = "failed";
            candidate.message = error instanceof Error ? error.message : String(error);
        } finally {
            this.reviewBusy = false;
        }
        if (this.reviewMode && this.currentReview() === candidate) {
            void this.renderReview();
        }
    }

    private async acceptReview(candidate: ICandidate): Promise<void> {
        if ("done" === candidate.status) {
            candidate.decision = "accepted";
            void this.renderReview();
            return;
        }
        if ("pending" !== candidate.status) {
            // 已标记跳过或失败时不允许采用
            showMessage(this.t(candidate.message || "not_worthwhile"));
            return;
        }
        if ("" === candidate.previewURL) {
            showMessage(this.t("stillEncoding"));
            return;
        }
        const buffer = this.reviewBuffers.get(candidate.path);
        if (!buffer) {
            showMessage(this.t("stillEncoding"));
            return;
        }
        this.reviewBusy = true;
        try {
            // 立即写入以免在内存中累积大量编码结果。
            // 原格式优化直接就地覆盖，路径不变，因此不需要等待批量重链。
            if ("optimize" === this.options().mode) {
                await writeInPlace(candidate, buffer);
            } else {
                await uploadCandidate(candidate, buffer);
            }
            this.reviewBuffers.delete(candidate.path);
            candidate.decision = "accepted";
        } catch (error) {
            candidate.status = "failed";
            candidate.message = error instanceof Error ? error.message : String(error);
        } finally {
            this.reviewBusy = false;
        }
        if (this.reviewMode && this.currentReview() === candidate) {
            void this.renderReview();
        }
    }

    private async finishReview(): Promise<void> {
        if (this.running) {
            return;
        }
        const mode = this.options().mode;
        this.closeReviewPool();
        this.setBusy(true);
        this.reviewBody.classList.add("isq-review--busy");
        this.setProgress(this.t("applying"));
        try {
            const summary = emptySummary();
            if ("optimize" === mode) {
                // 就地覆盖已在采用时完成，这里只需按终态汇总统计
                for (const candidate of this.candidates) {
                    if ("done" === candidate.status) {
                        summary.converted++;
                        summary.sourceSize += candidate.sourceSize;
                        summary.outputSize += candidate.outputSize;
                    } else if ("failed" === candidate.status) {
                        summary.failed++;
                    } else if ("skipped" === candidate.status) {
                        summary.skipped++;
                    }
                }
            } else {
                await applyAccepted(this.candidates, this.options(), summary, (candidate) => {
                    this.updateRow(candidate);
                }, () => this.aborted);
            }
            this.summary = summary;
            this.setProgress(this.t("finished"));
            this.renderFooter();
            this.renderSummary(summary);
        } catch (error) {
            showMessage(`${this.t("title")}: ${error instanceof Error ? error.message : String(error)}`);
            this.setProgress(this.t("runFailed"));
        } finally {
            this.setBusy(false);
            this.exitReview();
        }
    }
}
