# Phase 3.1 Spec — Performance

**Status:** implementation complete 2026-07-17; automated gates pass; production-Chrome profiling and live regression gate blocked
**Depends on:** Phases 0–2 implemented; phase 3 automated/package work complete
**Blocks:** nothing (phase 3's external gates — CWS review, production-Chrome QA — proceed independently; the QA matrix should be re-run after this phase lands)
**Reference docs:** `docs/03-architecture.md`, `docs/specs/phase-2-spec.md` (clangd lifecycle), `docs/specs/phase-2-verification.md` (existing boot/latency measurements)

---

## 1. Objective

Remove the known CPU, latency, and memory hot spots in the shipped pipeline without changing any user-visible behavior or the protocol's validation discipline:

1. clangd worker stdio is quadratic in message size (both directions) — the dominant per-request CPU cost for C++.
2. clangd.wasm (86 MB) is loaded without streaming compilation, so every boot recompiles from scratch and briefly doubles memory.
3. The page-side Monaco discovery loop (MutationObserver + poll) runs forever on a mutation-heavy React page.
4. Pyright boots eagerly for every LeetCode problem tab regardless of language and is never torn down.
5. Every feature request pays a serialized `pingBridge()` round trip, and a single ping timeout permanently disables the hook for the tab.

Phase 3.1 is done when the measurement plan in §5 shows the targeted improvements with zero regressions in the existing automated suites and the phase 1/2 live verification steps.

## 2. Non-goals

- Incremental LSP document sync (`contentChanges` with ranges). Full-text sync is retained: solution files are small, both engines reparse regardless, and the remap core assumes full text. Revisit only if profiling after this phase shows sync cost matters.
- Ambient-types refresh debouncing for JS/TS (string-equality guard already prevents `addExtraLib` churn; measured cost is negligible).
- Package/store size reduction (clangd.wasm size, optional "C++ pack" split) — tracked as a roadmap open decision, not runtime performance.
- Any protocol shape change, new permission, or feature change.

## 3. Findings baseline (what this spec fixes)

| # | Location | Problem | Class |
|---|---|---|---|
| F1 | `lib/engines/cpp/clangd-host.worker.ts` `stdout()` | `JSON.parse(decode(buffer))` attempted on **every output byte**; O(n²) CPU and O(n²) allocation per LSP message. Completion payloads are capped at 2,000 items and routinely reach hundreds of KB. | CPU |
| F2 | `lib/engines/cpp/clangd-host.worker.ts` `stdin()` / `send()` | `Array.shift()` per byte (O(n²)); `push(...encoder.encode(body))` spreads the encoded message into arguments — call-stack overflow risk for messages ≳64 K. | CPU + correctness hazard |
| F3 | `lib/engines/cpp/clangd-host.worker.ts` `boot()` | `fetch → arrayBuffer → wasmBinary` defeats `WebAssembly.instantiateStreaming` and Chrome's compiled-wasm code cache; every C++ boot recompiles 86 MB and holds a duplicate 86 MB JS-heap copy during init. | Boot latency + memory |
| F4 | `entrypoints/monaco-hook.content.ts` | MutationObserver on `document.documentElement` (childList+subtree) runs `discoverMonaco()` (two `querySelector` calls) on every mutation batch, forever; the 200 ms/90 s poll is redundant with the `window.monaco` setter trap. | Page CPU |
| F5 | `entrypoints/offscreen/engine-host.ts` + `lib/engines/shared/engine-backend.ts` | Python backend is `eager: true`: pyright boots when the offscreen document is created (any LeetCode problem tab, any language) and `eager` skips idle teardown, so it stays resident forever. | Memory |
| F6 | `entrypoints/monaco-hook.content.ts` `requestFeature()` | `pingBridge()` adds a serialized page↔isolated round trip before every completion/hover/signature request; one 250 ms timeout calls `cleanup()` and permanently kills the hook for the tab. | Latency + resilience |

## 4. Deliverables

| # | Deliverable | Definition |
|---|---|---|
| D1 | Linear clangd stdio | Content-Length-framed stdout parsing, cursor-based typed-array stdin; no per-byte parse attempts, no argument spreads of message-sized arrays |
| D2 | Streaming clangd.wasm instantiation | Emscripten loads the wasm by URL (streaming compile); Chrome code cache verified effective on warm boot; no full-file `ArrayBuffer` copy |
| D3 | Quiescent Monaco discovery | Observer + poll stop once Monaco is installed; discovery re-arms only on editor loss (CodeMirror swap / model disposal); steady-state page work is zero |
| D4 | Language-lazy pyright with idle teardown | Pyright boots on first Python `DOC_SYNC` (same lifecycle as clangd); idle teardown applies; first-completion latency gate decides warmup strategy |
| D5 | Ping-free request path | Liveness derived from the request/response cycle itself; transient bridge failure degrades a single request, never destroys the hook |
| D6 | Verification report `docs/specs/phase-3.1-verification.md` | Before/after measurements for every deliverable; regression evidence for phase 1/2 suites |

### Component requirements

#### D1 — clangd worker stdio (F1, F2)

- **stdout:** clangd emits standard LSP framing (`Content-Length: N\r\n\r\n<body>`). Parse the header, then accumulate exactly N bytes into a preallocated `Uint8Array` and decode/parse **once** per message. The current "start at `{`, try JSON.parse per byte" heuristic is deleted, including its silent discarding of header bytes.
- **stdin:** replace `Array<number|null>` + `shift()` with the encoded `Uint8Array` chunks and an index cursor; the chunk-terminating `null` sentinel becomes an explicit position check. No spread of message-sized arrays anywhere (fixes the ≥64 K stack hazard).
- **stderr:** unchanged (line-buffered debug logging is fine).
- The framing logic must be extracted into pure functions (no worker globals) so it is unit-testable in vitest: multi-message batches, messages split across arbitrary chunk boundaries, interleaved partial headers, non-ASCII payloads (the existing `\uXXXX` escaping in `send()` is retained), and a ≥1 MB message round-trip.
- The existing scripted clangd acceptance test (`npm run test:clangd`) must pass unchanged — it is the integration gate that framing still speaks real clangd.

#### D2 — Streaming wasm (F3)

- Drop `wasmBinary`; let Emscripten resolve `clangd.wasm` through `locateFile` and its default streaming-instantiation path (extension `chrome-extension://` URLs are same-origin fetches from the offscreen worker; COEP `require-corp` is already satisfied for extension resources — verify, don't assume).
- If the vendored Emscripten glue's default path does not stream (older glue falls back to `arrayBuffer`), implement the `instantiateWasm` hook with `WebAssembly.instantiateStreaming(fetch(url))` instead. Inspect the glue first; choose the smaller change.
- Measure and record: cold boot (first ever), warm boot (second boot in the same browser profile after teardown/re-boot) — warm boot must show the code cache effect (compile phase drops to near-zero). Record peak offscreen memory during boot before/after.
- The `.wasm` must be served with its bytes unchanged (code cache is URL+bytes keyed); no build-step change.

#### D3 — Monaco discovery quiescence (F4)

- Once `installMonaco` succeeds and an editor is active: disconnect the MutationObserver and clear the poll timer.
- Re-arm discovery (observer, not the poll) only when the tracked editor state is lost: active model disposal without replacement, `.monaco-editor` removal / `.cm-editor` appearance (the existing CodeMirror deactivation path), or the `window.monaco` setter firing with a new object (the trap already covers this without the observer).
- The 90 s bootstrap poll is retained **only** until first discovery (belt-and-braces for the trap being bypassed), then never restarted.
- `cleanup()` continues to dispose whatever is live. No behavior change to activation semantics — the same set of situations must still activate/deactivate the hook; only the steady-state cost changes.
- Testable via the existing hook-lifecycle patterns; live verification confirms editor swaps (problem navigation, language switches, layout changes) still re-attach.

#### D4 — Language-lazy pyright (F5)

- `engine-host.ts`: python backend becomes `eager: false` with the same idle-teardown policy as C++ (5 min, one shared default).
- `engine-backend.ts`: no structural change expected — lazy boot and idle teardown already exist and are exercised by the C++ path; this is a configuration flip plus removal of any eager-only assumptions (e.g. `handleCrash`'s `!this.options.eager` branch must be re-verified for the new config).
- **Latency gate:** measure first-Python-completion latency from cold offscreen (pyright boot + first request). Phase 1 measured pyright boot in seconds; the boot overlaps the user reading the problem only if we start it at first `DOC_SYNC` (which fires on model activation, well before the first completion). If measured first-completion latency after a model-activation boot exceeds **1 s** (the phase 2 target for clangd), keep the boot trigger at first `DOC_SYNC` but document the measured gap; if it exceeds **3 s**, escalate: this deliverable reverts to eager-with-teardown (boot eagerly, still tear down after idle) rather than shipping a degraded Python experience.
- Offscreen document lifetime itself is out of scope (closing it would drop ports; teardown of the engines inside it achieves the memory goal).

#### D5 — Ping-free requests (F6)

- Remove `pingBridge()` from `requestFeature()`. The request itself is the liveness probe: the existing 10 s request timeout already bounds failure.
- The bridge's `PING` handler may remain in the protocol (it costs nothing and the initial-connection path may still use it), but no per-request ping.
- Failure semantics change deliberately: a bridge outage now fails individual requests (empty completion list / null hover — the providers already swallow errors) instead of calling `cleanup()`. The only remaining `cleanup()` triggers are page unload and extension reload (the `__leetsense_cleanup` re-entry path). Verify the extension-reload story still works: the ISOLATED script's `ctx.onInvalidated` + `failOutstanding` already surfaces errors to pending requests, and a reloaded extension re-injects a fresh hook that calls the stale hook's `cleanup()` — confirm this chain in live testing since the ping-timeout path no longer provides it.
- Protocol validators unchanged.

## 5. Measurement plan (before → after, recorded in D6)

All measurements on the same machine, same Chrome profile, packaged build (`.output/chrome-mv3`), recorded in the verification report:

| Metric | How | Target |
|---|---|---|
| M1: C++ completion CPU | DevTools performance profile of the offscreen document while requesting completions in a `std::` context (large item lists); worker self-time in `stdout`/`stdin` paths | Framing cost linear; worker stdio self-time < 5 % of request wall time |
| M2: 1 MB message handling | Unit-level benchmark of framing functions | No stack overflow; single parse per message |
| M3: clangd cold boot | `[LeetSense] cpp ready in N ms` console line | No regression beyond noise |
| M4: clangd warm boot | Same, after idle teardown + re-boot in same profile | Materially below cold boot (code cache engaged) |
| M5: Boot peak memory | Chrome task manager / `performance.measureUserAgentSpecificMemory` in offscreen during boot | No 86 MB duplicate buffer spike |
| M6: Page steady-state cost | Performance profile of a LeetCode problem tab at idle, 60 s, after editor active | Zero LeetSense samples in steady state (no observer callbacks) |
| M7: Non-Python memory | Offscreen memory with only a C++/JS problem open | No pyright workers exist |
| M8: Python first completion | Cold offscreen → open Python problem → measure activation-to-first-completion | < 1 s after boot completes; boot trigger per D4 gate |
| M9: Feature request latency | Wall time of completion round trip before/after ping removal | One round trip removed; no regression |

## 6. Acceptance criteria

1. All existing vitest suites pass unchanged; new framing unit tests pass; `npm run test:clangd` passes; `npm run compile` and `npm run build` clean.
2. Phase 1 and phase 2 live verification feature checks (Python four features, C++ four features, JS/TS diagnostics, language switching, crash/reboot policy) re-run green on the packaged build.
3. Every metric in §5 recorded with before/after values in `docs/specs/phase-3.1-verification.md`; M1, M4, M5, M6, M7 show the qualitative change described.
4. No protocol shape change, no manifest change, no new permissions.
5. D4 latency gate decision documented (lazy vs eager-with-teardown), whichever way it lands.
