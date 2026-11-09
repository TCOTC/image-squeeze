import {fetchSyncPost} from "siyuan";
import type {
    IAssetReferencesData,
    IAssetRelinkMapping,
    IDirectoryEntry,
} from "./types";

/** 上传新资源的目标目录，使用全局资源目录以便得到唯一的 assets/ 链接路径。 */
const UPLOAD_ASSETS_DIR = "/assets/";

/** 从内核错误响应中取出可读信息。 */
const failureMessage = (response: any, fallback: string): string => {
    if (response && typeof response.msg === "string" && response.msg) {
        return response.msg;
    }
    return fallback;
};

/** 宽松调用结果的统一形态，便于调用方同时拿到内核消息与可能存在的部分数据。 */
export interface IApiResult<T> {
    code: number;
    message: string;
    data: T | undefined;
}

/** 严格调用：code 非 0 时抛错，错误消息取自内核的 msg。 */
export const apiPost = async <T>(url: string, data: any = {}): Promise<T> => {
    const response = await fetchSyncPost(url, data) as any;
    if (!response || response.code !== 0) {
        throw new Error(failureMessage(response, `request failed: ${url}`));
    }
    return response.data as T;
};

/**
 * 宽松调用：不抛错，把内核消息和 data 一并返回。
 * 批量资源接口在「全部映射项失败」时返回非 0 code 但带逐项结果，调用方需要同时拿到两者；
 * 若只保留 data，内核给出的原因会被丢失。
 */
export const apiPostLenient = async <T>(url: string, data: any = {}): Promise<IApiResult<T>> => {
    const response = await fetchSyncPost(url, data) as any;
    return {
        code: response && "number" === typeof response.code ? response.code : -1,
        message: failureMessage(response, `request failed: ${url}`),
        data: response ? response.data as T : undefined,
    };
};

/** 按资源路径批量查询引用及其可改写性。 */
export const findAssetReferences = (paths: string[]): Promise<IApiResult<IAssetReferencesData>> => {
    return apiPostLenient<IAssetReferencesData>("/api/asset/findAssetReferences", {paths});
};

/** 批量改写资源引用。全部失败时 code 非 0，但逐项结果仍在 data 中。 */
export const relinkAssets = (
    mappings: IAssetRelinkMapping[],
    dryRun = false,
): Promise<IApiResult<IAssetReferencesData>> => {
    return apiPostLenient<IAssetReferencesData>("/api/asset/relinkAsset", {mappings, dryRun});
};

/** 执行只读 SQL 查询。 */
export const querySql = async (stmt: string): Promise<Record<string, unknown>[]> => {
    return apiPost<Record<string, unknown>[]>("/api/query/sql", {stmt});
};

/** 列出工作空间内的目录，path 为 /data 起头的相对路径。 */
export const readDir = async (path: string): Promise<IDirectoryEntry[]> => {
    return apiPost<IDirectoryEntry[]>("/api/file/readDir", {path});
};

/**
 * 读取资源原始字节。该接口成功时直接返回二进制，失败时返回 202 加 JSON 错误体。
 * 资源在云端未下载到本地时也会失败，调用方应按「跳过」而非「异常」处理。
 */
export const readAssetBytes = async (assetPath: string): Promise<Blob> => {
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        body: JSON.stringify({path: `/data/${assetPath}`}),
    });
    if (response.status === 202) {
        const text = await response.text();
        let message = text;
        try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.msg) {
                message = parsed.msg;
            }
        } catch {
            // 非 JSON 错误体时直接使用原始文本
        }
        throw new Error(message || "failed to read asset");
    }
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    if (0 === blob.size) {
        throw new Error("asset is empty");
    }
    return blob;
};

/** 上传压缩后的资源，返回内核分配的资源路径，例如 assets/xxx-20230101120000-abc1234.webp。 */
export const uploadAsset = async (file: File): Promise<string> => {
    const form = new FormData();
    form.append("assetsDirPath", UPLOAD_ASSETS_DIR);
    form.append("file[]", file);
    const response = await fetchSyncPost("/api/asset/upload", form) as any;
    if (!response || response.code !== 0) {
        throw new Error(failureMessage(response, "failed to upload asset"));
    }
    const data = response.data || {};
    const succeeded = Array.isArray(data.succFiles) ? data.succFiles : [];
    if (1 > succeeded.length) {
        const failed = Array.isArray(data.failedFiles) ? data.failedFiles : [];
        const reason = failed.length > 0 && failed[0].error ? failed[0].error : "upload rejected by kernel";
        throw new Error(reason);
    }
    return succeeded[0].path as string;
};

/**
 * 删除工作空间内的单个文件，入参为 data 相对路径，例如 data/assets/xxx.png。
 * 仅用于删除已确认无引用的原图，不承担引用校验职责。
 */
export const removeFile = async (path: string): Promise<void> => {
    await apiPost("/api/file/removeFile", {path});
};

/**
 * 用新字节覆盖工作空间内的已有文件。用于原格式就地优化：
 * 路径与扩展名均不改变，因此无需改写任何引用，也不产生孤儿文件。
 */
export const putFile = async (assetPath: string, data: ArrayBuffer, mime: string): Promise<void> => {
    const name = assetPath.slice(assetPath.lastIndexOf("/") + 1);
    const form = new FormData();
    form.append("path", `/data/${assetPath}`);
    form.append("isDir", "false");
    form.append("file", new File([data], name, {type: mime}));
    const response = await fetchSyncPost("/api/file/putFile", form) as any;
    if (!response || response.code !== 0) {
        throw new Error(failureMessage(response, "failed to overwrite asset"));
    }
};
