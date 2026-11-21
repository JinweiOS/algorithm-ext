# Changelog

All notable changes to 速写 (Algo Ext) are documented here. The fork point
is LeetSense v1.2.2; earlier entries are inherited from upstream.

## 1.4.0 — 2026-11-21

### Added

- 面板内置 MiSans 可变字体（`public/fonts/MiSans-VF.woff2`，按界面字符裁剪到 419 个
  汉字 + 拉丁与标点，167 KB）。品牌面板与语言服务下拉菜单使用该字体；页内部分由
  隔离世界的 bridge 注入 `@font-face`，因此 LeetCode 页面不需要外网请求。
- 背景由静态渐变改为缓慢流动：`.aurora` 两层金色径向光斑以 22s 呼吸式位移，
  `::after` 是一条 17s 掠过的高光带；基础配色（`--paper-1..3`）未改。
- 鼠标悬停时叠加 GPU 液体墨水：`entrypoints/panel/fluid-cursor.ts` 是 splash-cursor
  流体场的原生实现（速度/染料双缓冲、旋度与涡量约束、Jacobi 压力、半拉格朗日平流、
  可选 bloom），以减色方式把奶油色墨迹（`#fff6d8`，附两档邻近色）印在纸上。

### Changed

- 液体画布跟随面板尺寸（`ResizeObserver`），入场动画展开时不再被拉伸；无指针活动后
  自动停帧并清空，`prefers-reduced-motion` 下整层跳过，只保留静态背景。
- 页内状态条保持继承 LeetCode 自己的排版（它和 `已存储` 同排），字号字重都不变；
  真正换成 MiSans 的是由我们绘制的那几层：品牌面板、语言服务下拉菜单与评价提示。

### Fixed

- 页内卡片边缘在浅色页面上有一圈白线：`<iframe>` 自带 16px 圆角，与外层圆角分别
  抗锯齿，两层之间还留着 1px 的边框内边距，浅色背景从这里透出。现在边框改为绘制在
  盒子外侧的 `box-shadow` 环，`<iframe>` 不再自带圆角，由外层统一裁剪。
- 页内卡片不再「悬停即拖拽」：整卡 `grab` 光标会抢走内容区的悬停，也让人误以为
  随手一按就会移动。改为六点抓手，点击后进入拖动模式（再点或按 `Esc` 退出），与
  右上角的 × 同一套悬停/点亮反馈。抓手放在落款同一行的右端，与「Power by 英格科技」
  共用一行，不再单独占一条底边留白。

### 许可证与发布

- 项目改为以 **GPL-3.0**（`GPL-3.0-only`）发布：分发修改版必须以同样许可开源并
  提供对应源码。上游 LeetSense（MIT）的版权与许可声明按 MIT 要求
  原样保留在 `legal/leetsense-MIT.txt`，版权归属与 ReactBits SplashCursor 的
  Commons Clause 现状记在 `NOTICE`。
- 发布归档改名为 `algo-ext-<version>.zip`，校验和同名加 `.sha256`。

## 1.3.0 — 2026-11-18

### Changed

- 更名为「速写」，出品方为英格科技：扩展名、弹窗、页内状态条与操作卡片统一为中文，
  署名改为 `Power by 英格科技`；面板与商店文案列出 Python、C++、JavaScript、TypeScript 四种语言。
- 换用新的品牌图标；工具栏默认显示灰色（未激活），引擎运行期间切换为彩色版本。
  图标由高清源图重采样生成（16–128 px，白底抠除并还原边缘色），无锯齿与黑边。
- 工具栏图标不再绑定原生 popup：点击时通过 `scripting` + `activeTab` 向当前页面注入
  悬浮品牌面板——圆角卡片、可整卡拖拽、× 按钮或 `Esc` 关闭、再点图标可切换显隐；
  面板高度由页面自行上报（postMessage），内容不会被裁切也不出现滚动条。
  无法注入的页面（`chrome://`、应用商店、PDF）回退为原生矩形弹窗，内容不变。
  `panel.html` 是唯一对外暴露的 web-accessible 资源。
- 注入面板加入入场编排：头部由右向左扫入 → logo 自下而上生长 → 下方内容由头部向下展开，
  卡片高度随内容逐帧上报；面板页以 `#framed` + `:target` 限定，原生弹窗回退仍即时呈现完整内容。
  三段改为彼此重叠的连锁（280 ms / 240 ms @150 ms / 340 ms @300 ms，全程 640 ms），
  比原先依次排队（总长 1240 ms）更快也更连贯。
- 面板关闭按钮改为居中的 SVG 叉：默认无背景，悬停淡入圆形底色、投影并轻微放大；
  面板页禁止滚动，入场动画期间不会闪现滚动条。
- 品牌面板改为金色浅色主题；页内操作卡片同步为浅色卡片，去掉英文文案与商店评价入口。
- 页内状态条改为 `英格科技速写 · Python · 就绪` 形式。
- 面板去掉顶端金色分隔线；浅色渐变固定到视口，高度变化时底色不再露出下方空白。

### Added

- JavaScript / TypeScript 有了自己的引擎，与 Python / C++ 同构：TypeScript 编译器 API
  (`ts.createLanguageService`) 跑在 offscreen 的 module worker 里，走同一条
  `monaco-hook → bridge → offscreen → 引擎` 链路。补全、悬停、参数提示、语义诊断四项能力齐全，
  标准库（ES2022 + DOM，63 个 `.d.ts`）随扩展打包，不再依赖页面是否加载语言包。
  JS 后端以 `allowJs` 运行：保留推断与成员补全，但不报类型错误。
- 补全列表每行都带类型签名：条目使用 Monaco 的 label 对象形式（名字 + `description`），
  并把签名放进 `detail`，因此像 LeetCode 原生提示一样显示 `at  (method) Array<any>.at(...)`。
- JavaScript / TypeScript 也有页内状态条与操作卡片：`英格科技速写 · TypeScript · 就绪`，
  并且和 Python / C++ 一样可以停止/重启（它们现在由自家后端持有）。
- 页面自带的 TypeScript 校验被强制关闭、它的补全/悬停/参数提示 provider 在注册处被拦截，
  避免同一行出现两份建议与两份波浪线。
- LeetCode 中文站 (`leetcode.cn`) problem pages are now in scope. Both content
  scripts match `leetcode.com` and `leetcode.cn`, and the status control anchors
  to the Chinese save label (`已存储`) as well as the English one.

### Fixed

- 修好了「`a.` 只提示一个 `length`」：LeetCode 的智能模式会把补全列表的方法/函数过滤关掉
  （`suggest.showMethods` / `showFunctions`），而数组除了唯一的属性 `length`，其余成员全是方法，
  于是整张列表只剩一行。速写现在在编辑器上把建议可见性固定为开启，并在页面每次
  `updateOptions` 之后重新应用（页面自己的其它 suggest 设置原样保留）。
- 修好了 JS/TS 补全取错位置的问题：协议里的位置是 LSP 语义（0 基），TypeScript 服务却按
  1 基处理，`p.` 的请求被解析到上一行行首，于是返回的是全局符号而不是 `Array` 成员。
- 修好了补全列表整列重复：provider 拦截器在每次 Monaco 重装时被还原并重放，
  页面自己的 TS provider 因此被放回注册表，每条建议都出现两份。拦截器现在常驻，
  只放行速写自己的注册，扩展卸载时才归还页面。
- Deferred the Monaco install by one task after `window.monaco` is assigned.
  Installing providers inside LeetCode's own bootstrap raced the page's service
  registry, which threw two uncaught "depends on UNKNOWN service" errors per
  editor on leetcode.cn's trimmed Monaco build.
- Relaxed the two TypeScript-compilation test timeouts so the suite stays green
  on slower machines (they compile the real ambient libraries).

## 1.2.2 — 2026-08-12

### Added

- Added persistent LeetSense branding beside LeetCode's `Saved` status so the
  product identity remains visible in editor screenshots.
- Added linked LeetSense and creator credits to the language-server action menu,
  plus a permanent Chrome Web Store review link in the extension popup.
- Added a neutral, one-time Chrome Web Store review reminder after at least one
  week, five qualified sessions across three active days, and 20 seconds of
  healthy editor inactivity.

### Privacy

- Kept review-reminder eligibility entirely on-device with only coarse session
  and active-day counts plus the one-time shown timestamp; no source code,
  visited URLs, selected languages, or activity history is retained or sent.
- Updated the privacy policy to disclose the local review-reminder state.

## 1.2.1 — 2026-08-12

### Added

- Made the Python and C++ status beside LeetCode's `Saved` label an accessible
  action menu for stopping, starting, or restarting the shared per-language
  language server across open tabs.

### Fixed

- Serialized manual lifecycle controls with automatic recovery so a stopped
  engine cannot be resurrected by document sync, bridge replay, or a stale boot,
  while Start and Restart reopen the newest retained documents.

Automated and package evidence, plus the remaining packaged-editor QA blocker,
are recorded in
[`docs/specs/phase-3.3-verification.md`](docs/specs/phase-3.3-verification.md).

## 1.2.0 — 2026-07-18

### Added

- Added backend-authored lifecycle status for Python and C++ beside LeetCode's
  `Saved` indicator. It stays visible, reports startup/restarts/failures, and
  does not show `Ready` until current diagnostics have reached the editor.
- Added privacy-safe structured performance logs for engine boot, document
  sync, diagnostics, feature latency, bridge reconnects, Port sessions, and UI
  lifecycle without logging source text or language-server payloads.
- Added a tested planned-restart policy for high clangd memory use. The live
  threshold remains dormant until the pinned clangd artifact exposes used heap
  rather than its fixed WebAssembly capacity.

### Performance

- Reduced C++ completion response work while preserving the full prelude and
  hover documentation after browserless measurements showed that trimming
  headers did not produce a reliable latency win.
- Closed the extension offscreen document after all engine sessions and clients
  have been idle through the existing five-minute grace period. The bridge
  recreates it automatically on the next Python or C++ request.

### Fixed

- Added timeout-based engine hang recovery with document replay, request
  quiescence, and a five-minute failure cooldown to prevent reboot loops.
- Made bridge reconnect replay the latest document before pending feature
  requests, while keeping later user actions recoverable after a failed race.
- Kept lifecycle UI synchronized across language switches, model swaps,
  navigation, extension reloads, idle teardown, and late session attachment.

### Release engineering

- Added a tag-driven GitHub Release workflow. An exact `vX.Y.Z` tag matching
  the canonical package version runs every release gate, builds the
  deterministic Chrome ZIP, and publishes it with a SHA-256 checksum.
- Kept Chrome Web Store submission manual and added fail-closed guards against
  malformed tags, mismatched versions, implicit tag creation, and release-asset
  replacement.

The implementation and measurement ledger are documented in
[`docs/specs/phase-3.2-spec.md`](docs/specs/phase-3.2-spec.md) and
[`docs/specs/phase-3.2-verification.md`](docs/specs/phase-3.2-verification.md).

## 1.1.0 — 2026-07-17

### Performance

- Replaced clangd's per-byte parsing and queue operations with linear,
  `Content-Length`-framed LSP I/O. Large responses are now decoded and parsed
  once, and message-sized argument spreads that could overflow the stack are
  gone.
- Changed clangd WebAssembly startup to resolve the module by URL, enabling
  Chrome's streaming compilation and compiled-WASM cache while avoiding a
  duplicate 90 MB JavaScript `ArrayBuffer` during initialization.
- Made Monaco discovery quiescent after editor activation. The bootstrap poll
  and page-wide mutation observer now stop in steady state and re-arm only when
  the tracked editor is lost.
- Made Pyright language-lazy: it starts on the first Python document sync
  instead of every LeetCode problem tab, then shuts down after five idle
  minutes when no Python session remains.
- Removed the extra bridge ping before completion, hover, and signature-help
  requests, reducing each feature operation from two serialized bridge round
  trips to one.

### Fixed

- Preserved clangd's Emscripten stdin read boundaries so C++ initialization and
  language features remain reliable in the packaged extension.
- A transient bridge failure now fails only the affected language request
  instead of permanently disabling LeetSense for the tab.

### Release engineering

- Made `package.json` the single release-version source for WXT manifests,
  release audits, and deterministic archive names.
- Added a release-version consistency gate covering `package.json`, the root
  lockfile entries, the generated extension manifest, and the packaged archive.

The implementation and measurement ledger are documented in
[`docs/specs/phase-3.1-spec.md`](docs/specs/phase-3.1-spec.md) and
[`docs/specs/phase-3.1-verification.md`](docs/specs/phase-3.1-verification.md).

## 1.0.0 — 2026-07-16

### Added

- Python 3 completions, hover documentation, signature help, and diagnostics
  powered locally by browser-basedpyright.
- JavaScript syntax diagnostics and TypeScript syntax/type diagnostics using
  LeetCode's bundled TypeScript language service.
- Ambient LeetCode judge types for linked lists, trees, and common node shapes.
- C++ semantic completions, hover documentation, signature help, and diagnostics
  powered locally by clangd 18 WebAssembly and matching libc++ headers.
- Automatic language-lazy C++ startup and five-minute idle teardown.
- Store identity and icons, privacy policy, third-party notices, deterministic
  dependency-license collection, and a release-package audit.

### Privacy

- No analytics, accounts, backend, remote code, data collection, or source-code
  transmission.
