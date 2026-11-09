const path = require("path");
const fs = require("fs");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");
const pluginManifest = require("./plugin.json");

// 内核把插件目录挂在 /plugins/<插件名>/ 下。
// 这里显式指定 publicPath，而不用 webpack 的自动推断：
// 自动推断会以执行脚本所在目录为基准，而 chunkFilename 自带目录前缀，
// 两者叠加会产生重复的路径段。
// 强制要求：本地开发产物与安装后产物的相对结构必须一致，
// 否则同一个 publicPath 无法同时适配。（package.zip 会把 dist/ 的内容提到根目录）
const pluginPublicPath = `/plugins/${pluginManifest.name}/`;

// 图标与预览图是可选的：plugin.json 里声明了就用声明的文件名，
// 没声明才回退到包根目录的 icon.png / preview.png。
// 注意两者的严格程度不同：
//   - 已声明：该文件必须存在，缺失视为打包配置错误，构建应当失败
//   - 未声明：遗留同名文件可有可无，缺失时静默跳过
const packageImagePatterns = [
    ["icon", "icon.png"],
    ["preview", "preview.png"],
].map(([field, legacyName]) => {
    const declared = pluginManifest[field];
    return {
        from: declared || legacyName,
        to: "./dist/",
        noErrorOnMissing: !declared,
    };
});

module.exports = (env, argv) => {
    const production = argv.mode === "production";
    // 资源使用内容哈希命名，不清理会累积旧文件，而 dist/ 下的残留会被打进 package.zip。
    // 仅清理 dist/，绝不能清理输出根目录（即项目目录）。
    if (production) {
        fs.rmSync(path.resolve(__dirname, "dist"), {recursive: true, force: true});
    }
    const plugins = [
        new MiniCssExtractPlugin({
            filename: production ? "dist/index.css" : "index.css",
        }),
    ];
    if (production) {
        plugins.push(
            new CopyPlugin({
                patterns: [
                    ...packageImagePatterns,
                    {from: "README*.md", to: "./dist/"},
                    {from: "plugin.json", to: "./dist/"},
                    {from: "src/i18n/", to: "./dist/i18n/"},
                ],
            }),
        );
        plugins.push(
            new ZipPlugin({
                filename: "package.zip",
                algorithm: "gzip",
                include: [/dist/],
                pathMapper: (assetPath) => {
                    return assetPath.replace("dist/", "");
                },
            }),
        );
    } else {
        plugins.push(
            new CopyPlugin({
                patterns: [
                    {from: "src/i18n/", to: "./i18n/"},
                ],
            }),
        );
    }
    return {
        mode: argv.mode || "development",
        watch: !production,
        devtool: production ? false : "eval-source-map",
        output: {
            filename: "[name].js",
            path: path.resolve(__dirname),
            publicPath: pluginPublicPath,
            // Worker 与 chunk 统一放在 chunk/ 下，wasm 放在 wasm/ 下。
            // 开发时直接输出到插件根目录，生产时先输出到 dist/ 再由 package.zip 提到根目录，
            // 两种情况的相对结构因而一致。
            chunkFilename: production ? "dist/chunk/[name].js" : "chunk/[name].js",
            // 编解码器的 wasm 由 webpack 依据 new URL(..., import.meta.url) 自动产出
            assetModuleFilename: production ?
                "dist/wasm/[name].[contenthash][ext]" :
                "wasm/[name].[contenthash][ext]",
        },
        externals: {
            siyuan: "siyuan",
        },
        // 必须显式指定：externalsType 的默认值由 output.library 推导，
        // 而 library 已下移到各 entry，推导会回退为 var，
        // 产物就变成引用裸全局 `siyuan`，而插件环境没有该全局，
        // 导致运行时 siyuan 为 undefined（表现为 Plugin 未定义）。
        externalsType: "commonjs",
        entry: {
            [production ? "dist/index" : "index"]: {
                import: "./src/index.ts",
                library: {type: "commonjs2"},
            },
            [production ? "dist/codecWorker" : "codecWorker"]: {
                import: "./src/codec/worker.ts",
                library: {type: "var", name: "isqCodecWorker"},
                // Worker 中没有 document，必须改用 importScripts 加载动态 chunk，
                // 否则 jsquash 内部的动态 import（如 WebP 的 SIMD 探测）会因缺少 document 而失败。
                chunkLoading: "import-scripts",
            },
        },
        optimization: {
            minimize: production,
            minimizer: [
                new EsbuildPlugin(),
            ],
        },
        resolve: {
            extensions: [".ts", ".scss", ".js", ".json"],
        },
        module: {
            rules: [
                // @jsquash 为纯 ESM 且内部使用省略扩展名的相对导入，
                // 需关闭 fullySpecified 才能解析。
                {
                    test: /\.m?js$/,
                    resolve: {fullySpecified: false},
                },
                {
                    test: /\.ts(x?)$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        {
                            loader: "esbuild-loader",
                            options: {
                                target: "es2020",
                            },
                        },
                    ],
                },
                {
                    test: /\.scss$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        MiniCssExtractPlugin.loader,
                        {
                            loader: "css-loader", // translates CSS into CommonJS
                        },
                        {
                            loader: "sass-loader", // compiles Sass to CSS
                        },
                    ],
                },
            ],
        },
        plugins,
    };
};
