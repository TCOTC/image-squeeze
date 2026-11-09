import {
    type Custom,
    openTab,
    Plugin,
    showMessage,
} from "siyuan";
import type zhCN from "./i18n/zh-CN.json";
import {SqueezeTab} from "./tab";
import "./index.scss";

const STORAGE_NAME = "config.json";

/** 页签类型；实际注册名会加上插件名作为前缀。 */
const TAB_TYPE = "squeeze";

/**
 * 已打开的页签实例。页签可能被布局恢复或重复打开，
 * 按 Custom 实例记录才能在 destroy 时精确释放对应的交互状态。
 */
const tabInstances = new Map<Custom, SqueezeTab>();

export default class ImageSqueezePlugin extends Plugin {
    declare i18n: typeof zhCN;

    onload() {
        this.loadData(STORAGE_NAME).catch((e) => {
            const errorMessage = `${this.displayName}: failed to load data [${STORAGE_NAME}]: ${e.msg}`;
            showMessage(errorMessage);
            console.error(errorMessage);
        });

        this.addTab({
            type: TAB_TYPE,
            init: (custom: Custom) => {
                tabInstances.set(
                    custom,
                    new SqueezeTab({
                        element: custom.element,
                        app: custom.app,
                        pluginName: this.name,
                        t: (key: string, ...args: string[]) => this.translate(key, ...args),
                    }),
                );
            },
            destroy() {
                tabInstances.get(this)?.destroy();
                tabInstances.delete(this);
            },
        });

        this.addCommand({
            langKey: "compressImages",
            hotkey: "",
            callback: () => {
                this.open();
            },
        });

        this.addTopBar({
            icon: "iconImage",
            title: this.i18n.title,
            position: "right",
            callback: () => {
                this.open();
            },
        });

        console.log(this.displayName, "plugin loaded");
    }

    onLayoutReady() {
        console.log(this.displayName, "plugin layout ready");
    }

    onunload() {
        for (const tab of tabInstances.values()) {
            tab.destroy();
        }
        tabInstances.clear();
        console.log(this.displayName, "plugin unloaded");
    }

    uninstall() {
        this.removeData(STORAGE_NAME).catch((e) => {
            const errorMessage = `${this.displayName}: failed to uninstall remove data [${STORAGE_NAME}]: ${e.msg}`;
            showMessage(errorMessage);
            console.error(errorMessage);
        });

        console.log(this.displayName, "plugin uninstalled");
    }

    private open() {
        // 全库改写引用需要写权限，只读工作区与发布态直接拒绝
        if (window.siyuan.config.readonly || window.siyuan.isPublish) {
            showMessage(this.i18n.readonly);
            return;
        }
        // 同一个页签只会存在一份，重复调用会切换到已打开的页签
        openTab({
            app: this.app,
            custom: {
                id: this.name + TAB_TYPE,
                title: this.i18n.title,
                icon: "iconImage",
            },
        });
    }

    /** 按 ${n} 占位符替换参数；翻译缺失时原样返回键名，便于暴露未翻译的文案。 */
    private translate(key: string, ...args: string[]): string {
        const raw = (this.i18n as Record<string, string>)[key];
        if (typeof raw !== "string") {
            return key;
        }
        return raw.replace(/\$\{(\d+)\}/g, (match, index: string) => {
            const value = args[Number(index)];
            return typeof value === "string" ? value : match;
        });
    }
}
