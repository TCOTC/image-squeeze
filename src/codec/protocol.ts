/**
 * 主线程与编解码 Worker 之间的消息协议。
 * 该文件只含类型，主线程与 Worker 都会引用，因此不得引入任何运行时依赖。
 */

/** 编码模式。 */
export type TEncodeMode =
    /** 保持原格式就地优化：PNG 走 oxipng 无损，JPEG 走 mozjpeg 重编码。 */
    | "optimize"
    /** 转为 WebP。 */
    | "webp";

/** 实际执行编码的编解码器标识，用于结果归因与展示。 */
export type TCodecName = "oxipng" | "mozjpeg" | "webp-lossless" | "webp-lossy";

export interface ICodecOptions {
    mode: TEncodeMode;
    /** 0 到 100，与各编码器的质量刻度一致。 */
    quality: number;
    /** WebP 无损编码。 */
    lossless: boolean;
    /** WebP 编码强度 0 到 6，越大越慢越小。 */
    method: number;
    /** 最长边像素上限；0 表示不缩放。仅 WebP 模式生效。 */
    maxDimension: number;
    /** oxipng 优化等级 1 到 6。 */
    oxipngLevel: number;
    /** mozjpeg 渐进式编码。 */
    progressive: boolean;
}

export interface ICodecRequest {
    id: number;
    /** 源文件原始字节。 */
    buffer: ArrayBuffer;
    options: ICodecOptions;
}

export interface ICodecSuccess {
    id: number;
    ok: true;
    /** 编码结果字节。 */
    buffer: ArrayBuffer;
    /** 编码后的 MIME 类型。 */
    type: string;
    /** 编码后的像素尺寸。 */
    width: number;
    height: number;
    /** 实际使用的编解码器。 */
    codec: TCodecName;
    /** 目标文件扩展名，含点号。 */
    ext: string;
}

export interface ICodecFailure {
    id: number;
    ok: false;
    error: string;
    /** 失败发生的阶段，便于区分是加载 wasm 还是编码本身出错。 */
    stage: "load" | "decode" | "encode";
}

export type TCodecResponse = ICodecSuccess | ICodecFailure;

/** 由编码结果推导的输出文件名。保持原名、仅替换扩展名，唯一 ID 交由内核追加。 */
export const outputNameOf = (assetPath: string, ext: string): string => {
    const slash = assetPath.lastIndexOf("/");
    const name = assetPath.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    return `${dot < 0 ? name : name.slice(0, dot)}${ext}`;
};
