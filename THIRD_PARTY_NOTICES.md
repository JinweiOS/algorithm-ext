# 速写 Third-Party Notices

速写 bundles the following third-party software. The extension package contains
the complete license texts referenced below, including a generated inventory and
license file for every production npm dependency under `licenses/npm/`.

This project's own code is licensed under the GPL-3.0 (`LICENSE`, shipped as
`licenses/GPL-3.0.txt`); `NOTICE` records the copyright, the upstream it was
forked from, and one open licensing question. Nothing below changes the terms
of the project's own licence, and nothing below is relicensed by it.

## LeetSense (upstream)

- Components: the extension this project started from — the WXT/MV3 scaffold,
  the Pyright and clangd language pipelines, the LeetCode page hooks, and the
  release tooling as of v1.2.2.
- Upstream: <https://github.com/C-W-D-Harshit/leetsense>, Copyright (c) 2026
  Harshit Sharma.
- License: MIT. The MIT notice is retained verbatim in
  `licenses/leetsense-MIT.txt`, which the MIT License requires of every copy and
  substantial portion of the software — including this one, whose own licence is
  the GPL-3.0.

## ReactBits SplashCursor

- Component: `entrypoints/panel/fluid-cursor.ts`, a TypeScript port of the
  SplashCursor fluid field.
- Upstream: <https://www.reactbits.dev/animations/splash-cursor>, Copyright (c)
  2026 David Haz.
- License: "MIT + Commons Clause License Condition v1.0", reproduced in
  `licenses/reactbits-LICENSE.md`. The Commons Clause forbids selling,
  sublicensing or redistributing the component itself — "whether alone, in a
  bundle, or as a ported version" — while allowing it to be used inside an
  application or product. This file is a ported version and it ships in source
  form, so it is a known risk rather than a settled permission; see `NOTICE`.

## clangd and Clang resource headers

- Components: `clangd.wasm`, its Emscripten loader/worker, and the matching
  Clang 18 resource-header pack.
- Upstream: LLVM Project 18.1.2 (`llvmorg-18.1.2`, commit
  `26a1d6601d727a96f4301d0d8647b5a42760ae0c`).
- License: Apache License 2.0 with LLVM Exceptions. Legacy and component-specific
  notices are reproduced in `licenses/LLVM-LICENSE.txt`.

## TypeFox clangd WebAssembly build

- Components: build scripts and packaged artifacts sourced from the TypeFox
  `monaco-languageclient` clangd WASM build at revision
  `d23725b88de0460fdb7b360bfe823ec850a1505a`.
- Source image: `ghcr.io/typefox/monaco-languageclient/clangd-wasm-build`, digest
  `sha256:751a6b12c5637f3e5043229cb4cbeb42deffef88f331be9716206fddb7057de`.
- License: MIT. Full text: `licenses/TypeFox-LICENSE.txt`.

## MiSans typeface

- Component: `public/fonts/MiSans-VF.woff2`, a character subset of the MiSans
  variable font (`MiSansVF.ttf`, `wght` 150–700).
- Upstream: MiSans, published by Xiaomi and free to use, including commercially.
- Modification: the file shipped here is subset to the glyphs this UI needs
  (Latin, the CJK characters in our own copy, punctuation); outlines are
  untouched and the `wght` axis is preserved.
- Coverage: `@font-face` declares the face with `font-display: swap` and a
  150–700 weight range, so a missing or blocked file degrades to the platform
  UI font instead of a blank strip.

## browser-basedpyright

- Component: `browser-basedpyright@1.39.9`, including its packaged Pyright
  browser worker.
- Upstream: https://github.com/detachhead/basedpyright
- Lineage: basedpyright's browser build was adapted from the
  micro:bit Educational Foundation's browser-oriented Pyright fork; Pyright is
  Copyright Microsoft Corporation.
- License: MIT. The exact license distributed by the npm package is copied to
  `licenses/npm/browser-basedpyright@1.39.9-LICENSE.txt`.

## VS Code language-server libraries and npm runtime dependencies

LeetSense directly uses `vscode-jsonrpc@9.0.1` and
`vscode-languageserver-protocol@3.18.2`, both under the MIT License and
Copyright Microsoft Corporation. Their transitive runtime dependencies are
bundled through the Pyright worker. A versioned inventory and each package's
verbatim license file are in `licenses/npm/INDEX.md` and adjacent files.

This notice is informational and does not alter any third-party license.
