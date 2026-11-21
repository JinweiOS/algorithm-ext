import { fileURLToPath } from 'node:url';

import { defineConfig } from 'wxt';

const PYRIGHT_WORKER_PATH = fileURLToPath(
  new URL(
    './node_modules/browser-basedpyright/dist/pyright.worker.js',
    import.meta.url,
  ),
);
const THIRD_PARTY_NOTICES_PATH = fileURLToPath(
  new URL('./THIRD_PARTY_NOTICES.md', import.meta.url),
);
const PRIVACY_POLICY_PATH = fileURLToPath(
  new URL('./PRIVACY.md', import.meta.url),
);
const LLVM_LICENSE_PATH = fileURLToPath(
  new URL('./legal/LLVM-LICENSE.txt', import.meta.url),
);
const TYPEFOX_LICENSE_PATH = fileURLToPath(
  new URL('./legal/TypeFox-LICENSE.txt', import.meta.url),
);
// GPL-3.0 asks for the licence itself to travel with the program, and the MIT
// text has to stay with the code inherited from LeetSense.
const GPL_LICENSE_PATH = fileURLToPath(new URL('./LICENSE', import.meta.url));
const NOTICE_PATH = fileURLToPath(new URL('./NOTICE', import.meta.url));
const LEETSENSE_LICENSE_PATH = fileURLToPath(
  new URL('./legal/leetsense-MIT.txt', import.meta.url),
);
const REACTBITS_LICENSE_PATH = fileURLToPath(
  new URL('./legal/reactbits-LICENSE.md', import.meta.url),
);

export default defineConfig({
  hooks: {
    'prepare:publicPaths'(_wxt, paths) {
      paths.push(
        'pyright/pyright.worker.js',
        'clangd/clangd.js',
        'clangd/clangd.wasm',
        'clangd/clangd.worker.mjs',
        'clangd/clang-resource-headers.pack.gz',
      );
    },
    'build:publicAssets'(_wxt, files) {
      files.push(
        {
          absoluteSrc: PYRIGHT_WORKER_PATH,
          relativeDest: 'pyright/pyright.worker.js',
        },
        {
          absoluteSrc: THIRD_PARTY_NOTICES_PATH,
          relativeDest: 'THIRD_PARTY_NOTICES.md',
        },
        {
          absoluteSrc: PRIVACY_POLICY_PATH,
          relativeDest: 'PRIVACY.md',
        },
        {
          absoluteSrc: LLVM_LICENSE_PATH,
          relativeDest: 'licenses/LLVM-LICENSE.txt',
        },
        {
          absoluteSrc: TYPEFOX_LICENSE_PATH,
          relativeDest: 'licenses/TypeFox-LICENSE.txt',
        },
        {
          absoluteSrc: GPL_LICENSE_PATH,
          relativeDest: 'licenses/GPL-3.0.txt',
        },
        {
          absoluteSrc: NOTICE_PATH,
          relativeDest: 'licenses/NOTICE',
        },
        {
          absoluteSrc: LEETSENSE_LICENSE_PATH,
          relativeDest: 'licenses/leetsense-MIT.txt',
        },
        {
          absoluteSrc: REACTBITS_LICENSE_PATH,
          relativeDest: 'licenses/reactbits-LICENSE.md',
        },
      );
    },
  },
  manifest: {
    name: '速写 - LeetCode 智能补全（Python / C++ / JS / TS）',
    description:
      '为 LeetCode 编辑器提供 Python、C++、JavaScript 与 TypeScript 的智能补全、悬停提示与实时诊断，语言服务全部在本机运行。',
    minimum_chrome_version: '116',
    // activeTab+scripting inject the floating brand panel into the clicked tab;
    // pages that reject injection fall back to the native popup.
    permissions: ['offscreen', 'scripting', 'activeTab'],
    icons: {
      16: 'icon/16.png',
      24: 'icon/24.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_icon: {
        16: 'icon/inactive/16.png',
        24: 'icon/inactive/24.png',
        32: 'icon/inactive/32.png',
        48: 'icon/inactive/48.png',
        128: 'icon/inactive/128.png',
      },
    },
    // The floating panel frames this page from arbitrary sites.
    web_accessible_resources: [
      { resources: ['panel.html'], matches: ['<all_urls>'] },
      // The in-page status strip borrows the bundled MiSans face, which the
      // page can only fetch through this declaration.
      { resources: ['fonts/*.woff2'], matches: ['<all_urls>'] },
    ],
    cross_origin_opener_policy: { value: 'same-origin' },
    cross_origin_embedder_policy: { value: 'require-corp' },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
