# Contributing to 速写 (Algo Ext)

Thanks for helping improve 速写. Focused bug reports, documentation fixes,
tests, and implementation improvements are welcome.

## Before opening an issue

- Search existing issues first.
- Confirm the problem on a LeetCode problem editor at `leetcode.com` using
  Chrome 116 or newer.
- Do not include LeetCode solution code, account details, credentials, or other
  private information in reports, screenshots, or logs.
- Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development setup

速写 requires Node.js, npm, and Deno. Install exact dependencies and run
the complete project gate:

```sh
npm ci
npm run check
```

For local browser testing:

1. Run `npm run build`.
2. Open `chrome://extensions` in Chrome and enable Developer mode.
3. Choose **Load unpacked** and select `.output/chrome-mv3`.
4. Exercise the affected behavior on a LeetCode problem page.

The C++ acceptance test starts the bundled clangd WebAssembly engine and can
take longer than the unit tests. Do not omit it from final verification.

## Pull requests

- Keep each pull request focused on one problem.
- Explain the user-visible behavior before and after the change.
- Add only the tests needed to prove the requested behavior.
- Run `npm run check` and report any browser QA performed.
- Update documentation when behavior, permissions, privacy claims, or bundled
  dependencies change.
- Never add remote executable code, telemetry, or a new permission without
  explicitly documenting the reason and privacy impact.

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
