# Phase 3.1 Verification Record — Performance

**Date:** 2026-07-17
**Status:** IMPLEMENTATION COMPLETE; AUTOMATED GATES PASS; PRODUCTION-CHROME PROFILING AND LIVE REGRESSION GATE BLOCKED
**Build:** `.output/chrome-mv3`

Phase 3.1's five code deliverables are implemented. The repository-local
tests, real clangd WebAssembly probe, strict compile, production build, and
release audit all pass. Measurements that require loading this exact unpacked
build in production Chrome remain blocked: the permitted non-T3 Chrome surface
can inspect normal tabs but cannot open Chrome's protected extension-management
page to load the local build. Existing store/live tabs do not contain these
uncommitted changes and therefore are not used as after-build evidence.

## Automated and package gates

| Check | Result | Evidence |
|---|---|---|
| Unit tests | PASS | `npm test`: 6 files, 33 tests |
| Linear framing coverage | PASS | split headers/bodies, multiple frames, non-ASCII, queued frame boundaries, and a >1 MiB frame |
| 1 MiB framing probe | PASS | 31 ms in the isolated vitest run; exactly one `JSON.parse`; no stack overflow |
| Real clangd WebAssembly acceptance | PASS | 43 completions, 18 semantic vector members, hover, two signatures, and intentional diagnostics |
| Strict TypeScript | PASS | `npm run compile` |
| Production WXT build | PASS | WXT 0.20.27; emitted worker uses URL-based WASM resolution and contains no `wasmBinary` |
| Release audit | PASS | v1.1.0; 109,036,296 emitted bytes; 89 production licenses; only `offscreen`; no host permissions or web-accessible resources |
| Deterministic release archive | PASS | `.output/leetsense-1.1.0-chrome.zip`; 115 files; 23,750,889 bytes; SHA-256 `ce88c9af5bc655143f46f5919617f92cc57e92665408e64df7bbc534a5bf3b14` |

The final real clangd acceptance run reported 9,258 ms for its browserless combined
boot-and-probe harness. That number is an integration health check, not M3: the
harness does not exercise Chrome's streaming compiler or code cache.

## Deliverable evidence

| Deliverable | Result | Evidence |
|---|---|---|
| D1 — linear clangd stdio | PASS | `LspMessageParser` parses `Content-Length` framing once per complete body into a preallocated `Uint8Array`; `LspStdinQueue` uses chunk/cursor reads; no message-sized spread or `shift()` remains |
| D2 — streaming clangd.wasm | IMPLEMENTED / LIVE CONFIRMATION BLOCKED | the vendored glue's `instantiateAsync` selects `WebAssembly.instantiateStreaming(fetch(...))` when `wasmBinary` is absent; the worker now supplies the extension URL through `locateFile` |
| D3 — quiescent Monaco discovery | IMPLEMENTED / LIVE CONFIRMATION BLOCKED | successful editor activation clears the bootstrap poll and disconnects the observer; model loss re-arms only the observer; the poll is never restarted |
| D4 — language-lazy Pyright | PASS CONFIGURATION / EXACT-BUILD LATENCY BLOCKED | Python changed from `eager: true` to `eager: false` and shares the five-minute idle policy with C++; backend tests prove lazy construction and teardown behavior |
| D5 — ping-free requests | PASS STATIC / LIVE RELOAD BLOCKED | the emitted hook contains no pending-ping path; each feature uses its existing request/response timeout and individual errors no longer call global cleanup |

The D4 decision remains **lazy with teardown**. Phase 1 measured 559 ms
boot-to-ready plus 51.4 ms ready-to-visible completion (610.4 ms combined),
comfortably below the 3 s eager-fallback threshold. The exact phase 3.1 build
must still be measured as M8 before the live gate can be marked green.

## M1–M9 measurement ledger

| Metric | Before | After / current evidence | Status |
|---|---|---|---|
| M1 — C++ completion CPU | stdout attempted decode/parse after every body byte; stdin used per-byte `shift()` | both paths are structurally O(n); DevTools self-time percentage unavailable | IMPLEMENTATION PASS; PROFILE BLOCKED |
| M2 — 1 MiB message | argument-spread overflow risk and quadratic queue/parser behavior | >1 MiB round-trip in 31 ms, one parse, no overflow | PASS |
| M3 — clangd cold boot | prior superseded build logged 3,436 ms | exact Chrome cold boot unavailable | BLOCKED |
| M4 — clangd warm boot | no streaming/code-cache path | URL-based streaming path emitted; cold/warm comparison unavailable | IMPLEMENTED; BLOCKED |
| M5 — boot peak memory | explicit 90.16 MB `arrayBuffer` retained as `wasmBinary` during init | duplicate JS buffer path removed; Chrome peak memory unavailable | IMPLEMENTED; BLOCKED |
| M6 — page steady state | root subtree observer plus 200 ms poll stayed active | poll/observer explicitly quiesce after editor activation; 60 s profile unavailable | IMPLEMENTED; BLOCKED |
| M7 — non-Python memory | Pyright constructed eagerly with the offscreen host and never idled out | Python client cannot construct before first Python sync and now tears down after five idle minutes | PASS AUTOMATED; PROCESS MEMORY BLOCKED |
| M8 — Python first completion | 610.4 ms prior component total (559 + 51.4 ms) | lazy mode retained; exact-build activation-to-completion unavailable | DECISION RECORDED; BLOCKED |
| M9 — feature request latency | two serialized page/bridge cycles (PING, then feature) | one request/response cycle; wall-time delta unavailable | STRUCTURAL PASS; PROFILE BLOCKED |

## Acceptance status

1. **PASS:** all existing and new unit tests, the real clangd harness, strict
   compile, production build, and release audit.
2. **BLOCKED:** packaged-build Python/C++/JS live feature and language-switching
   regression pass.
3. **PARTIAL:** M2 is numeric; M1 and M3–M9 record all available before/after
   evidence, but Chrome-only values remain explicit blockers.
4. **PASS:** no protocol shape, manifest, permission, or user-visible feature
   change.
5. **PASS WITH EXACT-BUILD FOLLOW-UP:** lazy Pyright retained from the prior
   610.4 ms evidence; M8 must confirm it on this build.

## Remaining manual Chrome pass

1. Load `.output/chrome-mv3` through `chrome://extensions` in production Chrome.
2. Run M1 and M3–M9 exactly as described in the phase 3.1 spec, including cold
   then post-teardown warm clangd boot and Chrome Task Manager memory.
3. Re-run Python/C++ four-feature checks, JS/TS diagnostics, language switches,
   editor swap/navigation, idle teardown, crash/reboot, and extension reload.
4. Replace the BLOCKED cells above with numeric/live evidence. Revert Python to
   eager-with-teardown only if exact-build M8 exceeds 3 s.
