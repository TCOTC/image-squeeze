import {
    findAssetReferences,
    putFile,
    querySql,
    readAssetBytes,
    readDir,
    relinkAssets,
    removeFile,
    uploadAsset,
} from "./api";
import {CodecPool} from "./codec/pool";
import {
    outputNameOf,
    type ICodecOptions,
} from "./codec/protocol";
import type {
    IAssetRelinkMapping,
    ICandidate,
    ICandidateReference,
    ICompressOptions,
    ICompressSummary,
    IUnavailableAttributeView,
} from "./types";

/** 可参与转换的源格式。GIF、SVG、HEIC 等一律跳过。 */
const SUPPORTED_EXTS = [".png", ".jpg", ".jpeg"];

export const WEBP_MIME = "image/webp";

/** 把界面选项转换为编解码 Worker 的选项。 */
export const codecOptionsOf = (options: ICompressOptions): ICodecOptions => ({
    mode: options.mode,
    quality: options.quality,
    lossless: options.lossless,
    method: options.method,
    // 原格式优化不改变尺寸，因此只有转 WebP 时才传递缩放上限
    maxDimension: "webp" === options.mode ? options.maxDimension : 0,
    oxipngLevel: options.oxipngLevel,
    progressive: options.progressive,
});

const extOf = (path: string): string => {
    const index = path.lastIndexOf(".");
    return index < 0 ? "" : path.slice(index).toLowerCase();
};

/**
 * 归一化候选路径：仅去掉查询参数与片段。
 * 不做 URL 解码，因为内核会对传入路径和文档中的链接各解码一次，
 * 参数保持链接中的原始形态才能与内核的 oldPath 对齐；
 * 若提前解码，`assets/a%23b.png` 会被内核当成片段分隔符而匹配失败。
 * 不以受支持扩展名结尾的异常路径会在后续过滤中被丢弃。
 */
const normalizeCandidatePath = (raw: string): string => {
    let path = String(raw || "").trim();
    const cut = path.search(/[?#]/);
    if (0 <= cut) {
        path = path.slice(0, cut);
    }
    // 内核会忽略一个前导斜杠，这里统一去掉以便后续比较
    return path.replace(/^\//, "");
};

const isSupported = (path: string): boolean => {
    if (!path.startsWith("assets/")) {
        return false;
    }
    // 内核的 relinkPath 会拒绝反斜杠、控制字符以及含冒号的路径段
    if (
        path.includes("\\") || path.includes("\u0000") || path.includes("\r") || path.includes("\n") ||
        path.split("/").some((segment) => segment.includes(":"))
    ) {
        return false;
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    if ("" === name || name.startsWith(".")) {
        return false;
    }
    return SUPPORTED_EXTS.includes(extOf(path));
};

/** 递归枚举全局资源目录，覆盖未在文档中引用但实际存在的图片。 */
const walkAssetsDir = async (dir: string): Promise<string[]> => {
    const found: string[] = [];
    let entries;
    try {
        entries = await readDir(dir);
    } catch {
        return found;
    }
    for (const entry of entries) {
        const child = `${dir}/${entry.name}`;
        if (entry.isDir) {
            found.push(...await walkAssetsDir(child));
            continue;
        }
        found.push(child.replace(/^data\//, ""));
    }
    return found;
};

/**
 * 枚举候选图片。同时取文档引用索引与磁盘实际文件，避免遗漏仅被数据库引用的资源。
 * SQL 的 assets 表不含属性视图引用，磁盘遍历负责补齐这一部分。
 */
export const listCandidatePaths = async (): Promise<string[]> => {
    const paths = new Set<string>();
    try {
        const rows = await querySql("SELECT DISTINCT path FROM assets");
        for (const row of rows) {
            const path = normalizeCandidatePath(String(row.path || ""));
            if (isSupported(path)) {
                paths.add(path);
            }
        }
    } catch {
        // SQL 不可用时仅依赖磁盘遍历
    }
    for (const raw of await walkAssetsDir("data/assets")) {
        const path = normalizeCandidatePath(raw);
        if (isSupported(path)) {
            paths.add(path);
        }
    }
    return Array.from(paths).sort();
};

export const createCandidate = (path: string): ICandidate => ({
    path,
    ext: extOf(path),
    refCount: 0,
    relinkable: false,
    reason: "",
    referenced: false,
    // 默认全部不勾选，由用户显式选择要处理的图片
    selected: false,
    decision: "undecided",
    status: "pending",
    sourceSize: 0,
    outputSize: 0,
    message: "",
    newPath: "",
    previewURL: "",
    sourceURL: "",
    outputType: "",
    outputExt: "",
    codec: "",
    outputWidth: 0,
    outputHeight: 0,
    savingRatio: 0,
});

export interface IAnalyzeResult {
    candidates: ICandidate[];
    /** 按候选路径分组的引用位置，供引用浮窗展示。 */
    references: Map<string, ICandidateReference[]>;
    /** 数据库定义缺失或无效的位置；内核跳过它们并上报。 */
    unavailableViews: IUnavailableAttributeView[];
}

/**
 * 批量查询引用与可改写性。内核按输入顺序返回同长度的 items，
 * 因此可以按下标把结果回填到候选列表。
 */
export const analyzeCandidates = async (paths: string[]): Promise<IAnalyzeResult> => {
    const candidates = paths.map(createCandidate);
    const references = new Map<string, ICandidateReference[]>();
    if (0 === candidates.length) {
        return {candidates, references, unavailableViews: []};
    }
    const result = await findAssetReferences(paths);
    const data = result.data;
    const items = data && Array.isArray(data.items) ? data.items : null;
    if (!items) {
        // 逐项结果缺失说明批量查询整体失败，直接把内核消息作为错误抛出
        throw new Error(result.message);
    }
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const item = items[i];
        if (!item) {
            // 逐项结果缺项时无法判断引用情况，按“可能被引用”保守处理并禁止处理，
            // 否则会被当成未引用资源而删除原图
            candidate.reason = "no_result";
            candidate.referenced = true;
            candidate.relinkable = false;
            candidate.status = "failed";
            candidate.message = "no_result";
            continue;
        }
        const list = Array.isArray(item.references) ? item.references : [];
        candidate.refCount = list.length;
        candidate.referenced = 0 < list.length;
        candidate.relinkable = item.ok === true;
        candidate.reason = item.reason || "";
        if (0 === candidate.refCount) {
            candidate.message = "unreferenced";
        } else if (!candidate.relinkable) {
            candidate.message = candidate.reason || "notRelinkable";
        }
        if (0 < list.length) {
            references.set(
                candidate.path,
                list.map((reference) => ({
                    candidatePath: candidate.path,
                    reference,
                    hPath: "",
                    snippet: "",
                    resolvable: false,
                })),
            );
        }
    }
    const views = data && Array.isArray(data.unavailableAttributeViews) ? data.unavailableAttributeViews : [];
    return {candidates, references, unavailableViews: views};
};

/**
 * 补齐引用位置的可读信息。内核只返回文档内部路径与块 ID，
 * 因此按块 ID 批量查询文档路径与内容摘要，供引用浮窗展示。
 */
export const describeReferences = async (references: ICandidateReference[]): Promise<void> => {
    const pending = references.filter((item) => "" === item.hPath && "" !== item.reference.blockID);
    if (0 === pending.length) {
        return;
    }
    const ids = Array.from(new Set(pending.map((item) => item.reference.blockID)));
    const quoted = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    if ("" === quoted) {
        return;
    }
    let rows: Record<string, unknown>[];
    try {
        rows = await querySql(`SELECT id, hpath, content FROM blocks WHERE id IN (${quoted})`);
    } catch {
        // 查询失败时仅展示文档内部路径，不影响引用清单本身
        return;
    }
    const found = new Map<string, {hPath: string; snippet: string;}>();
    for (const row of rows) {
        const id = String(row.id || "");
        if ("" === id) {
            continue;
        }
        found.set(id, {
            hPath: String(row.hpath || ""),
            snippet: String(row.content || "").replace(/\s+/g, " ").trim(),
        });
    }
    for (const item of pending) {
        const hit = found.get(item.reference.blockID);
        if (hit) {
            item.hPath = hit.hPath;
            item.snippet = hit.snippet;
            // 只有在 blocks 表中查到的才是文档内的块，可安全按块 ID 跳转
            item.resolvable = true;
        }
    }
};

const errorText = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
};

export const emptySummary = (): ICompressSummary => ({
    converted: 0,
    skipped: 0,
    failed: 0,
    sourceSize: 0,
    outputSize: 0,
    historyPath: "",
    leftovers: [],
    orphans: 0,
    deleted: 0,
    aborted: false,
});

/** 释放候选持有的对象地址，避免长时间占用内存。 */
export const releasePreview = (candidate: ICandidate): void => {
    if ("" !== candidate.previewURL) {
        URL.revokeObjectURL(candidate.previewURL);
        candidate.previewURL = "";
    }
    if ("" !== candidate.sourceURL) {
        URL.revokeObjectURL(candidate.sourceURL);
        candidate.sourceURL = "";
    }
};

/**
 * 读取并编码单张候选图片，但不写入工作空间。
 * 返回可直接用于上传或就地覆盖的字节；预览地址与尺寸信息同时写回候选对象。
 */
export const encodeCandidate = async (
    candidate: ICandidate,
    options: ICompressOptions,
    pool: CodecPool,
): Promise<ArrayBuffer> => {
    candidate.status = "encoding";
    const source = await readAssetBytes(candidate.path);
    candidate.sourceSize = source.size;
    releasePreview(candidate);
    candidate.sourceURL = URL.createObjectURL(source);
    const encoded = await pool.encode(await source.arrayBuffer(), codecOptionsOf(options));
    candidate.outputSize = encoded.buffer.byteLength;
    candidate.outputType = encoded.type;
    candidate.outputExt = encoded.ext;
    candidate.codec = encoded.codec;
    candidate.outputWidth = encoded.width;
    candidate.outputHeight = encoded.height;
    candidate.savingRatio = 1 - candidate.outputSize / candidate.sourceSize;
    candidate.previewURL = URL.createObjectURL(new Blob([encoded.buffer], {type: encoded.type}));
    return encoded.buffer;
};

/** 上传已编码的图片，记录内核分配的新资源路径。 */
export const uploadCandidate = async (candidate: ICandidate, buffer: ArrayBuffer): Promise<void> => {
    candidate.status = "uploading";
    const name = outputNameOf(candidate.path, candidate.outputExt || ".webp");
    candidate.newPath = await uploadAsset(new File([buffer], name, {type: candidate.outputType}));
    if (candidate.newPath === candidate.path) {
        throw new Error("kernel returned the original asset path");
    }
    candidate.status = "done";
};

/**
 * 原格式就地覆盖：路径与扩展名都不变，因此不需要改写任何引用，
 * 也不会产生孤儿文件。这是风险最低的替换方式。
 */
export const writeInPlace = async (candidate: ICandidate, buffer: ArrayBuffer): Promise<void> => {
    candidate.status = "uploading";
    await putFile(candidate.path, buffer, candidate.outputType);
    candidate.newPath = candidate.path;
    candidate.status = "done";
    candidate.message = "optimizedInPlace";
};

/**
 * 对已上传的候选执行收尾：批量改写引用、删除未引用资源的原图、复查残留。
 * 单张失败不影响其他候选；引用改写按批量一次提交以减少全库扫描与重复写入。
 */
export const applyAccepted = async (
    candidates: ICandidate[],
    options: ICompressOptions,
    summary: ICompressSummary,
    onProgress: (candidate: ICandidate) => void,
    isAborted: () => boolean,
): Promise<void> => {
    const uploaded = candidates.filter((candidate) => "done" === candidate.status && "" !== candidate.newPath);
    const mappings: IAssetRelinkMapping[] = [];
    const mapped: ICandidate[] = [];
    for (const candidate of uploaded) {
        if (candidate.referenced) {
            mappings.push({oldPath: candidate.path, newPath: candidate.newPath});
            mapped.push(candidate);
        }
    }
    if (0 < mappings.length && !isAborted()) {
        const relinkResult = await relinkAssets(mappings, false);
        const relinkData = relinkResult.data;
        if (relinkData) {
            summary.historyPath = relinkData.historyPath || "";
        }
        // 逐项结果缺失说明这次请求整体失败，此时所有映射项都未生效
        const items = relinkData && Array.isArray(relinkData.items) ? relinkData.items : [];
        for (let i = 0; i < mapped.length; i++) {
            const item = items[i];
            if (item && item.ok === true) {
                continue;
            }
            const candidate = mapped[i];
            candidate.status = "failed";
            candidate.message = item && item.reason ? item.reason : (relinkResult.message || "relink_failed");
            summary.orphans++;
            onProgress(candidate);
        }
    }
    // 未引用资源没有可改写的引用，确认采用后直接删除原图，否则转换只会留下另一个孤儿文件
    if (!isAborted()) {
        for (const candidate of uploaded) {
            if (candidate.referenced || "done" !== candidate.status || !options.deleteUnreferenced) {
                continue;
            }
            try {
                await removeFile(`data/${candidate.path}`);
                candidate.message = "deletedOriginal";
                summary.deleted++;
            } catch (error) {
                candidate.status = "failed";
                candidate.message = errorText(error);
            }
            onProgress(candidate);
        }
    }
    recount(summary, candidates);
    const oldPaths = candidates
        .filter((candidate) => "done" === candidate.status && candidate.referenced)
        .map((candidate) => candidate.path);
    if (options.verify && 0 < oldPaths.length && !isAborted()) {
        try {
            const verified = await findAssetReferences(oldPaths);
            const verifiedItems = verified.data && Array.isArray(verified.data.items) ? verified.data.items : null;
            if (!verifiedItems) {
                summary.leftovers.push(`verify_failed: ${verified.message}`);
            } else {
                for (let i = 0; i < oldPaths.length; i++) {
                    const item = verifiedItems[i];
                    const remaining = item && Array.isArray(item.references) ? item.references.length : 0;
                    if (0 < remaining) {
                        summary.leftovers.push(oldPaths[i]);
                    }
                }
            }
        } catch (error) {
            summary.leftovers.push(`verify_failed: ${errorText(error)}`);
        }
    }
};

/** 按当前状态重算统计，避免增量累加在失败回退时出现偏差。 */
const recount = (summary: ICompressSummary, candidates: ICandidate[]): void => {
    let converted = 0;
    let failed = 0;
    let sourceSize = 0;
    let outputSize = 0;
    for (const candidate of candidates) {
        if ("done" === candidate.status) {
            converted++;
            sourceSize += candidate.sourceSize;
            outputSize += candidate.outputSize;
        } else if ("failed" === candidate.status) {
            failed++;
        }
    }
    summary.converted = converted;
    summary.failed = failed;
    summary.sourceSize = sourceSize;
    summary.outputSize = outputSize;
};

/** 不支持或收益不足时抛出，交由调用方标记为跳过。 */
export class SkipCandidateError extends Error {
    constructor(public readonly messageKey: string) {
        super(messageKey);
        this.name = "SkipCandidateError";
    }
}

/**
 * 判断编码结果是否值得替换。体积必须小于原图并达到最小节省比例，
 * 否则替换只会让笔记变大（例如已高度压缩的 JPEG 转 WebP 后反而更大）。
 * 批量处理与逐张确认共用该判断，避免两处规则不一致。
 */
export const isWorthwhile = (candidate: ICandidate, options: ICompressOptions): boolean => {
    if (0 >= candidate.sourceSize || 0 >= candidate.outputSize) {
        return false;
    }
    // 无论阈值如何设置，都不允许用相等或更大的文件替换原文件
    if (0 >= candidate.savingRatio) {
        return false;
    }
    return candidate.savingRatio >= options.minSavingRatio;
};

/**
 * 编码结果的可用性校验：输出格式必须符合当前模式，且收益达标。
 * 返回应标记的跳过原因；可用于替换时返回空串。
 * 批量处理与逐张确认共用该判断，避免两处规则不一致。
 */
export const checkEncoded = (candidate: ICandidate, options: ICompressOptions): string => {
    if ("webp" === options.mode) {
        if (candidate.outputType !== WEBP_MIME) {
            return "webp_encoding_unsupported";
        }
        // JPEG 本身已经有损，无损 WebP 会把压缩痕述完整记录下来，体积会明显变大
        if (options.lossless && [".jpg", ".jpeg"].includes(candidate.ext)) {
            return "lossless_not_effective_for_jpeg";
        }
    } else if ("image/png" !== candidate.outputType && "image/jpeg" !== candidate.outputType) {
        // 原格式优化只应产出 PNG 或 JPEG；出现其他格式说明编码器回退，必须拒绝
        return "unexpected_output_format";
    }
    if (!isWorthwhile(candidate, options)) {
        return "not_worthwhile";
    }
    return "";
};

/**
 * 批量处理。原格式优化逐张就地覆盖（无需重链，因此可以立即写入）；
 * 转 WebP 则先逐张上传，最后统一改写引用以减少全库扫描与重复写入。
 * 内存中只保留当前图片的编码结果，因此可用于全库规模。
 */
export const runBatch = async (
    candidates: ICandidate[],
    options: ICompressOptions,
    pool: CodecPool,
    onProgress: (candidate: ICandidate) => void,
    isAborted: () => boolean,
): Promise<ICompressSummary> => {
    const summary = emptySummary();
    const inPlace = "optimize" === options.mode;
    for (const candidate of candidates) {
        if (isAborted()) {
            summary.aborted = true;
            break;
        }
        try {
            const buffer = await encodeCandidate(candidate, options, pool);
            const skipReason = checkEncoded(candidate, options);
            if (skipReason) {
                throw new SkipCandidateError(skipReason);
            }
            if (inPlace) {
                await writeInPlace(candidate, buffer);
            } else {
                await uploadCandidate(candidate, buffer);
            }
        } catch (error) {
            if (error instanceof SkipCandidateError) {
                candidate.status = "skipped";
                candidate.message = error.messageKey;
                summary.skipped++;
            } else {
                candidate.status = "failed";
                candidate.message = errorText(error);
                summary.failed++;
            }
            onProgress(candidate);
            continue;
        }
        onProgress(candidate);
    }
    if (inPlace) {
        // 已逐张写入，无需重链与清理，只需按终态重算统计
        recount(summary, candidates);
    } else {
        await applyAccepted(candidates, options, summary, onProgress, isAborted);
    }
    return summary;
};
