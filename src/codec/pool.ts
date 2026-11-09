import type {
    ICodecFailure,
    ICodecOptions,
    ICodecRequest,
    ICodecSuccess,
    TCodecResponse,
} from "./protocol";

/** 单张图片的编码结果。 */
export interface IEncodeOutcome {
    buffer: ArrayBuffer;
    type: string;
    ext: string;
    codec: string;
    width: number;
    height: number;
}

interface IPendingTask {
    id: number;
    buffer: ArrayBuffer;
    options: ICodecOptions;
    resolve: (result: IEncodeOutcome) => void;
    reject: (error: Error) => void;
}

interface IWorkerSlot {
    worker: Worker;
    current: IPendingTask | null;
}

/**
 * 编解码线程池。Worker 脚本由 webpack 打包为 codecWorker.js，与 index.js 同目录，
 * 因此路径可由插件名推导：内核把插件目录挂在 /plugins/<name>/ 下。
 */
export class CodecPool {
    private readonly url: string;
    private readonly size: number;
    private readonly slots: IWorkerSlot[] = [];
    private readonly waiting: IPendingTask[] = [];
    private nextID = 1;
    private closed = false;
    private loadFailure = "";

    constructor(pluginName: string, size = 2) {
        this.url = `/plugins/${encodeURIComponent(pluginName)}/codecWorker.js`;
        this.size = Math.max(1, size);
    }

    /** Worker 脚本缺失或加载失败时的原因，供界面提示用户重新构建。 */
    public get failure(): string {
        return this.loadFailure;
    }

    public encode(buffer: ArrayBuffer, options: ICodecOptions): Promise<IEncodeOutcome> {
        if (this.closed) {
            return Promise.reject(new Error("codec pool is closed"));
        }
        if ("" !== this.loadFailure) {
            return Promise.reject(new Error(this.loadFailure));
        }
        return new Promise<IEncodeOutcome>((resolve, reject) => {
            this.waiting.push({id: this.nextID++, buffer, options, resolve, reject});
            this.dispatch();
        });
    }

    public close(): void {
        this.closed = true;
        for (const task of this.waiting.splice(0)) {
            task.reject(new Error("codec pool is closed"));
        }
        for (const slot of this.slots) {
            slot.worker.terminate();
        }
        this.slots.length = 0;
    }

    private dispatch(): void {
        while (0 < this.waiting.length) {
            let target: IWorkerSlot | undefined = this.slots.find((slot) => null === slot.current);
            if (!target && this.slots.length < this.size) {
                target = this.createSlot();
            }
            if (!target) {
                return;
            }
            const task = this.waiting.shift();
            if (!task) {
                return;
            }
            this.run(target, task);
        }
    }

    /** Worker 脚本加载失败通常意味着插件未重新构建，此时直接给出可操作的提示。 */
    private failAll(reason: string): void {
        if (this.loadFailure) {
            return;
        }
        this.loadFailure = reason;
        for (const task of this.waiting.splice(0)) {
            task.reject(new Error(reason));
        }
        for (const slot of this.slots) {
            const task = slot.current;
            slot.current = null;
            if (task) {
                task.reject(new Error(reason));
            }
        }
    }

    private createSlot(): IWorkerSlot {
        const worker = new Worker(this.url);
        const slot: IWorkerSlot = {worker, current: null};
        worker.onmessage = (event: MessageEvent<TCodecResponse>) => {
            const task = slot.current;
            slot.current = null;
            if (!task) {
                return;
            }
            const data = event.data;
            // strictNullChecks 关闭时联合类型不会按字面量窄化，因此显式转换
            if (data && true === (data as ICodecSuccess).ok) {
                const success = data as ICodecSuccess;
                task.resolve({
                    buffer: success.buffer,
                    type: success.type,
                    ext: success.ext,
                    codec: success.codec,
                    width: success.width,
                    height: success.height,
                });
            } else {
                const failure = data as ICodecFailure;
                task.reject(new Error((failure && failure.error) || "encoding failed"));
            }
            this.dispatch();
        };
        // 脚本本身加载失败时不会有 onmessage，只能靠 onerror 判断
        worker.onerror = () => {
            const task = slot.current;
            slot.current = null;
            if (task) {
                task.reject(new Error(this.loadFailure || "codec worker failed"));
            }
            this.failAll(`cannot load codec worker at ${this.url}; rebuild the plugin and reload`);
        };
        this.slots.push(slot);
        return slot;
    }

    private run(slot: IWorkerSlot, task: IPendingTask): void {
        slot.current = task;
        const request: ICodecRequest = {id: task.id, buffer: task.buffer, options: task.options};
        slot.worker.postMessage(request, [task.buffer]);
    }
}
