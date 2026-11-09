/**
 * 编解码 Worker。由 webpack 打包为独立文件，主线程通过 /plugins/<name>/codecWorker.js 加载。
 *
 * 编码器来自 @jsquash（Squoosh 的 WASM 编解码器移植），其 wasm 通过
 * `new URL("xxx.wasm", import.meta.url)` 引用，webpack 会据此自动产出并重写为资源地址。
 */
import {encode as encodeJpeg} from "@jsquash/jpeg";
// 直接使用 oxipng 的单线程构建：包内的默认入口会在 Worker 中探测多线程，
// 进而依赖 SharedArrayBuffer 与嵌套 Worker（需要 COOP/COEP 响应头）。
// 思源内核不发送这些响应头，该分支不可用，而它一旦初始化失败会被记忆化，
// 导致后续所有 PNG 优化全部失败。这里直接锁定单线程实现，行为确定且少一份 wasm。
import initOxipng, {optimise as optimisePngSingleThread} from "@jsquash/oxipng/codec/pkg/squoosh_oxipng.js";
import {encode as encodeWebp} from "@jsquash/webp";
import type {
    ICodecOptions,
    ICodecRequest,
    ICodecSuccess,
    TCodecName,
    TCodecResponse,
} from "./protocol";

/** 按需初始化 oxipng 的 wasm，只初始化一次。 */
let oxipngReady: Promise<unknown> | null = null;
const ensureOxipng = (): Promise<unknown> => {
    if (!oxipngReady) {
        oxipngReady = initOxipng();
    }
    return oxipngReady;
};

/**
 * 把 wasm 返回的字节规范为紧凑的 ArrayBuffer。
 * wasm 的返回值可能是较大缓冲区的视图，直接取 buffer 会带上无关字节，
 * 而且类型上是 ArrayBufferLike，因此统一复制一份。
 */
const asArrayBuffer = (value: ArrayBuffer | ArrayBufferLike | Uint8Array): ArrayBuffer => {
    if (!(value instanceof Uint8Array)) {
        return value as ArrayBuffer;
    }
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
};

/**
 * 无损优化 PNG。直接吃原始字节，不需要解码，也不改变尺寸与格式。
 */
const optimisePng = async (data: ArrayBuffer, level: number): Promise<ArrayBuffer> => {
    await ensureOxipng();
    return asArrayBuffer(optimisePngSingleThread(
        new Uint8Array(data),
        Math.min(6, Math.max(1, level)),
        false,
        false,
    ));
};

type TSourceFormat = "png" | "jpeg" | "unknown";

/** 按魔数判断源格式，不依赖上层传入的 MIME。 */
const sniffFormat = (data: ArrayBuffer): TSourceFormat => {
    const bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
    if (4 <= bytes.length && 0x89 === bytes[0] && 0x50 === bytes[1] && 0x4e === bytes[2] && 0x47 === bytes[3]) {
        return "png";
    }
    if (3 <= bytes.length && 0xff === bytes[0] && 0xd8 === bytes[1] && 0xff === bytes[2]) {
        return "jpeg";
    }
    return "unknown";
};

/**
 * 从 PNG 的 IHDR 读取尺寸。无损优化路径不需要解码，
 * 直接读文件头即可拿到尺寸，避免为此付出一次完整解码的开销。
 */
const readPngSize = (data: ArrayBuffer): {width: number; height: number;} => {
    if (24 > data.byteLength) {
        return {width: 0, height: 0};
    }
    const view = new DataView(data);
    return {width: view.getUint32(16), height: view.getUint32(20)};
};

/** 解码为像素数据，并按需等比缩放。缩放使用高质量插值。 */
const toImageData = async (
    data: ArrayBuffer,
    maxDimension: number,
): Promise<{image: ImageData; width: number; height: number;}> => {
    // 显式应用 EXIF 方向，避免带方向的照片被转正后又旋转回去
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(new Blob([data]), {imageOrientation: "from-image"});
    } catch {
        bitmap = await createImageBitmap(new Blob([data]));
    }
    let width = bitmap.width;
    let height = bitmap.height;
    if (0 < maxDimension && (width > maxDimension || height > maxDimension)) {
        const scale = maxDimension / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", {willReadFrequently: true});
    if (!context) {
        bitmap.close();
        throw new Error("cannot acquire 2d context");
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return {image: context.getImageData(0, 0, width, height), width, height};
};

interface IEncoded {
    buffer: ArrayBuffer;
    type: string;
    ext: string;
    codec: TCodecName;
    width: number;
    height: number;
}

/** 保持原格式就地优化。PNG 无损且无需解码，JPEG 重新编码。 */
const encodeKeepFormat = async (
    data: ArrayBuffer,
    format: TSourceFormat,
    options: ICodecOptions,
): Promise<IEncoded> => {
    if ("png" === format) {
        const optimised = await optimisePng(data, options.oxipngLevel);
        const {width, height} = readPngSize(data);
        return {buffer: optimised, type: "image/png", ext: ".png", codec: "oxipng", width, height};
    }
    if ("jpeg" === format) {
        const {image, width, height} = await toImageData(data, 0);
        const encoded = await encodeJpeg(image, {
            quality: Math.min(100, Math.max(1, Math.round(options.quality))),
            progressive: options.progressive,
            // 开启 trellis 量化以在同等质量下获得更小体积
            trellis_multipass: true,
            optimize_coding: true,
            auto_subsample: true,
        });
        return {buffer: asArrayBuffer(encoded), type: "image/jpeg", ext: ".jpg", codec: "mozjpeg", width, height};
    }
    throw new Error("unsupported source format for in-place optimisation");
};

/** 转为 WebP，支持有损与无损。 */
const encodeWebpFormat = async (data: ArrayBuffer, options: ICodecOptions): Promise<IEncoded> => {
    const {image, width, height} = await toImageData(data, options.maxDimension);
    const encoded = await encodeWebp(image, {
        quality: Math.min(100, Math.max(1, Math.round(options.quality))),
        method: Math.min(6, Math.max(0, options.method)),
        lossless: options.lossless ? 1 : 0,
        // 无损时保留透明区域的 RGB，避免透明像素被清零导致与无损预期不符
        exact: options.lossless ? 1 : 0,
    });
    return {
        buffer: asArrayBuffer(encoded),
        type: "image/webp",
        ext: ".webp",
        codec: options.lossless ? "webp-lossless" : "webp-lossy",
        width,
        height,
    };
};

const run = async (request: ICodecRequest): Promise<ICodecSuccess> => {
    const format = sniffFormat(request.buffer);
    let encoded: IEncoded;
    if ("optimize" === request.options.mode) {
        encoded = await encodeKeepFormat(request.buffer, format, request.options);
    } else {
        encoded = await encodeWebpFormat(request.buffer, request.options);
    }
    return {
        id: request.id,
        ok: true,
        buffer: encoded.buffer,
        type: encoded.type,
        ext: encoded.ext,
        codec: encoded.codec,
        width: encoded.width,
        height: encoded.height,
    };
};

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<ICodecRequest>) => void) | null;
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

scope.onmessage = async (event: MessageEvent<ICodecRequest>) => {
    const request = event.data;
    try {
        const response = await run(request);
        scope.postMessage(response, [response.buffer]);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 编解码器首次使用会动态加载 wasm 与胶水代码，此阶段的失败需要单独区分
        const stage = /wasm|WebAssembly|import|fetch|module/i.test(message) ? "load" : "encode";
        const failure: TCodecResponse = {id: request.id, ok: false, error: message, stage};
        scope.postMessage(failure);
    }
};
