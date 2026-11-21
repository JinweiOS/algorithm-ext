# 速写

LeetCode 智能补全，由英格科技出品（Power by 英格科技）。

速写把真正的语言引擎搬进 Chrome：在 LeetCode 的 Monaco 编辑器里提供语义补全、
悬停文档、参数提示与实时诊断。没有 AI、没有账号、没有后端，不上传任何源码。

速写是独立项目，与 LeetCode 官方无隶属关系。

## 支持语言

| 语言 | 引擎 | 能力 |
|---|---|---|
| Python 3 | browser-basedpyright | 补全、悬停、参数提示、诊断 |
| C++ | clangd 18 WebAssembly + libc++ 头文件 | STL 语义补全、悬停、参数提示、诊断 |
| JavaScript | TypeScript 编译器 API（offscreen worker，`allowJs`） | 补全、悬停、参数提示、诊断 |
| TypeScript | TypeScript 编译器 API（offscreen worker） | 补全、悬停、参数提示、诊断 |

LeetCode 的 `ListNode`、`TreeNode` 以及常见的 `Node` 结构都被语言链路识别，补全与
类型检查按题目里实际的链表、二叉树定义工作。

JavaScript 与 TypeScript 由速写自己的引擎回答：TypeScript 语言服务跑在 offscreen
worker 里，标准库（ES2022 + DOM）随扩展打包，不依赖页面加载哪套语言包。页面自带的
TypeScript 校验与补全被关闭、拦截，避免同一行出现两份提示与两份波浪线。

## 安装

Chrome 应用商店版本仍在等待生产环境验收与商店审核。想先用上，可以直接加载本地构建：

1. 执行 `npm ci` 与 `npm run build`。
2. 打开 `chrome://extensions`，开启右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」，选择 `.output/chrome-mv3`。
4. 打开任意 LeetCode 题目。速写会自动启动，没有任何需要配置的选项。

点击工具栏图标，会在页面里打开一张悬浮的品牌卡片：点卡片底部的六点抓手进入拖动
模式（再点一次或按 `Esc` 退出），右上角的 × 或 `Esc` 可以关闭卡片，再点一次图标
重新打开。在无法注入界面的页面上（`chrome://`、应用商店等），点击会回退成浏览器
原生的弹窗，内容一致。

## 面板视觉

面板内置 MiSans 可变字体子集（`public/fonts`，167 KB，不联网加载），背景是一层缓慢
流动的暖色纸感渐变；指针在卡片上移动时，会激起一层 GPU 计算的淡色墨迹，只在指针位于
面板内时运行，停手后自动清空。点击不做任何事——它只是背景，不是玩具。
`prefers-reduced-motion` 生效时，动效与墨迹整体关闭，只保留静态卡片。

## 语言服务器控制

任何受支持的语言，都可以点 LeetCode 的「已存储」旁边那行状态来重启或停止对应的语言
服务器；停止后该状态改为「启动」。指令作用于所有打开着的、使用同一语言的 LeetCode
标签页，不会写入持久化设置。

## 隐私

所有分析都在本地完成。速写不收集、不保留、不上传代码与用户数据，也不发起任何远程
请求。详见 [PRIVACY.md](PRIVACY.md)。

## 资源占用与限制

- C++ 支持内置了较大的 clangd WebAssembly 二进制。引擎只在 C++ 编辑器活跃时启动，
  最后一个 C++ 会话闲置五分钟后自动关闭。
- v1 不支持 Java，按需排到后续版本。
- 速写只支持 `leetcode.com` 与 `leetcode.cn` 上的 Monaco 题目编辑器；CodeMirror
  编辑器与非题目页面不在范围内。在 `leetcode.cn` 上，状态控件锚定中文的「已存储」。
- 需要 Chrome 116 或更高版本。

## 开发

```sh
npm ci
npm test
npm run check
npm run zip
```

`npm run check` 依次跑单元测试、真实 clangd WebAssembly 验收、严格 TypeScript 检查、
生产构建与发布包审计。构建时会把每个生产依赖的许可证一并归档进扩展。

发版时，版本号要同时改 `package.json` 与 lockfile，然后跑完整门禁并打包这次确切的构建：

```sh
npm version patch --no-git-tag-version
npm run check
npm run zip
```

按需要把 `patch` 换成 `minor`、`major` 或具体版本号。`package.json` 是版本号的唯一
来源：WXT 的 manifest、发布审计、确定性的归档文件名都从它派生。CHANGELOG 里的
「未发布」标题，等目标版本与发布日期确定后再改。

## 持续集成与发布

每个指向 `main` 的 PR 和每次推送到 `main`，都会在 GitHub Actions 里跑完整的发布门禁；
同一改动的旧运行会被取消，合并前必须通过 `CI / Verify release gates` 检查。

推送一个与 `package.json` 完全一致的标签（例如 `v1.4.0`）会跑同一套门禁，并发布一个
GitHub Release，内含扩展包 `algo-ext-<version>.zip` 与它的 SHA-256 校验和。标签与
版本号不一致、或格式不对，会在发布前失败。

Release 成功后，`Submit Chrome package` 任务会停在受保护的 `chrome-web-store` 环境等待
批准。批准后它会下载该 Release 里那个确切版本的扩展包，用 GitHub 的 OIDC 身份换取短期
的 Google 服务账号令牌，通过 Chrome Web Store API v2 上传，并提交审核（校验警告视为
阻断）。审核通过后 Chrome 才会正式推送更新。部署失败可以重试，不需要重新构建或替换
GitHub Release。

该环境定义了以下非机密变量：

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
- `CWS_PUBLISHER_ID`
- `CWS_EXTENSION_ID`

仓库里不保存任何服务账号 JSON 密钥、OAuth 客户端密钥或 refresh token。Google Cloud、
Chrome Web Store 发布者与受保护环境的一次性配置见
[`docs/specs/ci-cd-spec.md`](docs/specs/ci-cd-spec.md)。

随扩展打包的第三方组件与来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

速写站在别人的肩上，这里明确道谢：

- **LeetSense**（MIT）— 本项目的起点。WXT/MV3 骨架、Pyright 与 clangd 两条语言链路、
  LeetCode 页面钩子以及整套发布工具都源自它；上游的 MIT 声明按许可证要求原样保留在
  [`legal/leetsense-MIT.txt`](legal/leetsense-MIT.txt)。
- **[ReactBits](https://www.reactbits.dev/animations/splash-cursor)** — 面板上那层
  流体墨迹是它的 SplashCursor 移植；其 Commons Clause 的约束与处理方式记在
  [NOTICE](NOTICE) 里。
- **[clangd](https://clangd.llvm.org/) / LLVM** — C++ 引擎，Apache-2.0 with LLVM
  Exceptions；WASM 构建来自 TypeFox 的 monaco-languageclient 流水线。
- **[basedpyright](https://github.com/detachhead/basedpyright)**（Microsoft Pyright
  的社区分支）— Python 引擎，MIT。
- **[MiSans](https://hyperos.mi.com/font)**（小米）— 界面字体，按 MiSans 授权内置子集。

## 贡献与安全

Bug 报告与聚焦的改进入口都欢迎。提交 PR 前请读
[CONTRIBUTING.md](CONTRIBUTING.md)；安全漏洞请走上报流程
[SECURITY.md](SECURITY.md)，不要开公开 issue。

## 许可证

本项目的源代码以 **GNU General Public License v3.0**（`GPL-3.0-only`）发布，
全文见 [LICENSE](LICENSE)，随扩展分发的副本在 `licenses/GPL-3.0.txt`。

也就是说：**你可以在任何项目里使用、修改、分发速写，但一旦分发修改后的版本，
就必须同样以 GPL-3.0 开源，并提供完整的对应源码。** 版权归属见
[NOTICE](NOTICE)。

第三方组件（clangd、basedpyright、VS Code 语言服务库、MiSans 等）不因本项目
改用 GPL 而改变，各自的条款见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
