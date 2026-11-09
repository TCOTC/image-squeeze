/**
 * 内核资源引用查询与重链接口的类型声明，与 kernel/apicontract/asset_relink.go 对应。
 */

export interface IAssetReference {
    /** 该引用命中的旧资源路径；仅在批量响应中出现。 */
    oldPath?: string;
    /** 引用类型，如 link、html、attribute、title-image、av-asset、av-url、ocr、annotation 等。 */
    type: string;
    notebook: string;
    rootID: string;
    path: string;
    blockID: string;
    avID: string;
    valueID: string;
    /** 原始链接文本。 */
    reference: string;
    /** 改写后的链接文本；查询模式下为空。 */
    replacement: string;
    /** 该引用是否可被安全改写。 */
    relinkable: boolean;
    /** 不可改写的原因。 */
    reason: string;
}

export interface IAssetRelinkItem {
    oldPath: string;
    newPath: string;
    ok: boolean;
    reason: string;
    references: IAssetReference[];
    updated: number;
}

export interface IAssetReferencesData {
    /** 逐项结果；仅在批量响应中出现。 */
    items?: IAssetRelinkItem[];
    references: IAssetReference[];
    /** 被跳过的加密笔记本 ID。 */
    skippedNotebooks: string[];
    /** 数据库定义缺失或 ID 无效的位置；内核跳过这些位置并上报。 */
    unavailableAttributeViews?: IUnavailableAttributeView[];
    dryRun: boolean;
    /** 恢复用的历史目录。 */
    historyPath: string;
    updated: number;
}

/**
 * 引用扫描时无法检查的数据库位置。
 * 对应位置的数据库定义文件已丢失（或引用 ID 无效），内核会跳过并在此上报，
 * 因为定义不存在时其中不可能含有指向目标资源的引用。
 */
export interface IUnavailableAttributeView {
    avID: string;
    notebook: string;
    notebookName: string;
    rootID: string;
    blockID: string;
    /** 文档内部路径。 */
    path: string;
    /** 人类可读的文档路径，例如 /反链 SQL/收集箱 - SQL 测试。 */
    hPath: string;
    /** 原因，取值为 missing_definition 或 invalid_id。 */
    reason: string;
}

export interface IAssetRelinkMapping {
    oldPath: string;
    newPath: string;
}

export interface IDirectoryEntry {
    name: string;
    isDir: boolean;
    isSymlink: boolean;
    updated: number;
}

/** 候选资源的处理状态。 */
export type TCandidateStatus =
    | "pending"
    | "encoding"
    | "uploading"
    | "done"
    | "skipped"
    | "failed";

/** 逐张确认时用户对当前图片的决定。 */
export type TReviewDecision = "accepted" | "rejected" | "undecided";

export interface ICandidate {
    /** 链接形式路径，例如 assets/xxx.png。 */
    path: string;
    ext: string;
    /** 引用数；为 0 表示当前没有任何引用。 */
    refCount: number;
    /** 全部引用均可改写时为 true；未引用资源恒为 true。 */
    relinkable: boolean;
    /** 不可改写或未通过预检的原因。 */
    reason: string;
    /** 是否被文档、数据库或题头图引用。 */
    referenced: boolean;
    /** 是否被勾选。初始一律为 false，由用户显式选择。 */
    selected: boolean;
    /** 逐张确认模式下的决定。 */
    decision: TReviewDecision;
    status: TCandidateStatus;
    /** 原始字节数。 */
    sourceSize: number;
    /** 压缩后的字节数。 */
    outputSize: number;
    /** 处理失败或被跳过时的说明。 */
    message: string;
    /** 转换后由内核返回的新资源路径。 */
    newPath: string;
    /** 压缩后图片的预览地址，用于前后对比；未压缩时为空。 */
    previewURL: string;
    /** 原图的预览地址。 */
    sourceURL: string;
    /** 压缩后图片的输出格式，用于识别编码回退。 */
    outputType: string;
    /** 编码结果的目标扩展名，含点号。 */
    outputExt: string;
    /** 实际使用的编解码器，例如 oxipng、mozjpeg、webp-lossy。 */
    codec: string;
    /** 压缩后的像素尺寸。 */
    outputWidth: number;
    outputHeight: number;
    /** 原图尺寸相对当前参数的加速比；已压缩后填充。 */
    savingRatio: number;
}

/** 编码模式。 */
export type TEncodeMode =
    /** 保持原格式就地优化：PNG 走 oxipng 无损，JPEG 走 mozjpeg。路径不变，无需改写引用。 */
    | "optimize"
    /** 转为 WebP，需要上传新资源并改写引用。 */
    | "webp";

export interface ICompressOptions {
    mode: TEncodeMode;
    /** 质量 0 到 100，与各编码器的刻度一致。 */
    quality: number;
    /** WebP 无损编码。 */
    lossless: boolean;
    /** WebP 编码强度 0 到 6，越大越慢但越小。 */
    method: number;
    /** oxipng 优化等级 1 到 6。 */
    oxipngLevel: number;
    /** mozjpeg 渐进式编码。 */
    progressive: boolean;
    /** 最长边像素上限；0 表示不缩放。仅 WebP 模式生效，原格式优化不会改变尺寸。 */
    maxDimension: number;
    /** 最小节省比例，低于该比例则放弃替换。 */
    minSavingRatio: number;
    /** 是否在重链后复查旧路径是否已无引用。 */
    verify: boolean;
    /**
     * 未引用资源转换成功后是否删除原图。
     * 仅 WebP 模式需要：未引用资源没有可改写的引用，转换后会留下另一份文件。
     */
    deleteUnreferenced: boolean;
}

export interface ICompressSummary {
    converted: number;
    skipped: number;
    failed: number;
    sourceSize: number;
    outputSize: number;
    /** 重链时使用的历史目录。 */
    historyPath: string;
    /** 仍残留引用的旧路径。 */
    leftovers: string[];
    /** 已上传但未能改写引用的新资源数量，会变成未引用文件。 */
    orphans: number;
    /** 未引用资源中已删除的源文件数量。 */
    deleted: number;
    /** 用户中止时为 true。 */
    aborted: boolean;
}

/** 一张图片的引用位置，用于引用清单与浮窗展示。 */
export interface ICandidateReference {
    /** 该引用所属的候选资源路径。 */
    candidatePath: string;
    /** 内核返回的原始引用信息。 */
    reference: IAssetReference;
    /** 引用所在文档的人类可读路径；按需解析，未解析时为空。 */
    hPath: string;
    /** 引用所在块的内容摘要；按需解析，未解析时为空。 */
    snippet: string;
    /**
     * 引用所在块是否可跳转。
     * 数据库资源列的引用值属于行内元素，不在 blocks 表中，无法按块 ID 打开文档。
     */
    resolvable: boolean;
}
