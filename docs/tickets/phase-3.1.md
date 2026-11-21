# Phase 3.1 Implementation Tickets — Performance

**Spec:** `docs/specs/phase-3.1-spec.md`
**Status:** IMPLEMENTATION COMPLETE; AUTOMATED GATES PASS; LIVE CHROME MEASUREMENT GATE BLOCKED

Order: P3.1-1 → P3.1-2 (same file, sequential to keep diffs reviewable), P3.1-3 / P3.1-4 / P3.1-5 independent and parallelizable after that, P3.1-6 last. No ticket changes protocol shapes, the manifest, or user-visible behavior.

## P3.1-1 — Linear clangd worker stdio (spec F1, F2 / D1)

**Status:** IMPLEMENTED — framing tests and real clangd acceptance pass; M1's DevTools CPU percentage awaits the exact packaged build in Chrome.

- Extract pure, unit-testable framing functions (no worker globals) for both directions:
  - **Outbound (stdout):** parse standard LSP `Content-Length` framing from the byte stream; accumulate exactly N body bytes in a preallocated `Uint8Array`; decode + `JSON.parse` once per message. Delete the start-at-`{`, parse-per-byte heuristic.
  - **Inbound (stdin):** queue of encoded `Uint8Array` chunks with an index cursor replacing `Array<number|null>` + `shift()`; end-of-chunk becomes a position check, not a `null` sentinel. No spread of message-sized arrays (`push(...encoded)` removed — ≥64 K stack hazard).
- Keep `send()`'s non-ASCII `\uXXXX` escaping and stderr line buffering unchanged.
- Vitest: multi-message batches; messages split at arbitrary chunk boundaries; partial headers across chunks; non-ASCII payloads; ≥1 MB message round-trip (M2). Write tests only for the behavior above — no string-matching or redundant contract tests.

**Gate:** new framing tests green; `npm run test:clangd` passes unchanged; M1 profile shows worker stdio self-time < 5 % of completion wall time.

## P3.1-2 — Streaming clangd.wasm instantiation (spec F3 / D2)

**Status:** IMPLEMENTED — emitted worker delegates to Emscripten's verified streaming path; M3–M5 need production Chrome.

- Inspect the vendored Emscripten glue (`public/clangd/clangd.js`) first: if its default path streams when `wasmBinary` is absent and `locateFile` returns the URL, drop the `fetch → arrayBuffer → wasmBinary` block; otherwise implement the `instantiateWasm` hook with `WebAssembly.instantiateStreaming(fetch(url))`. Choose the smaller change.
- Verify the offscreen worker can fetch the extension URL under COEP `require-corp` (expected yes for same-extension resources — confirm, don't assume).
- No build-step or asset change; `.wasm` bytes unchanged (code cache is URL+bytes keyed).
- Measure cold boot (M3), warm boot after idle teardown + re-boot in the same profile (M4), and boot peak memory (M5).

**Gate:** C++ features work end-to-end on the packaged build; M4 materially below cold boot (code cache engaged); M5 shows no 86 MB duplicate-buffer spike; M3 no regression.

## P3.1-3 — Quiescent Monaco discovery (spec F4 / D3)

**Status:** IMPLEMENTED — observer and bootstrap poll quiesce after activation and observer re-arms on tracked model loss; M6 needs production Chrome.

- `entrypoints/monaco-hook.content.ts`: on successful install with an active editor, disconnect the MutationObserver and clear the poll timer.
- Re-arm the observer only on editor-loss signals: active model disposal without replacement, CodeMirror swap (`.cm-editor` present / `.monaco-editor` gone), monaco-object replacement (setter trap already fires without the observer).
- Bootstrap poll (200 ms / 90 s) runs only until first discovery, never restarted.
- Activation semantics unchanged: the same situations must still attach/detach providers and markers; only steady-state work changes. `cleanup()` disposes whatever is live.

**Gate:** M6 — 60 s idle profile of an active problem tab shows zero LeetSense observer samples; live checks: problem navigation, Python ↔ C++ ↔ JS switches, and layout changes still re-attach correctly.

## P3.1-4 — Language-lazy pyright (spec F5 / D4)

**Status:** IMPLEMENTED — Pyright is lazy with the shared five-minute teardown; prior 610.4 ms component timing supports retaining lazy mode, while the exact-build M8 check remains blocked.

- `entrypoints/offscreen/engine-host.ts`: python backend `eager: false`, same idle-teardown default as C++.
- `lib/engines/shared/engine-backend.ts`: audit eager-only assumptions (notably the `handleCrash` `!this.options.eager` branch) under the new config; structural changes not expected.
- Measure M7 (no pyright workers on C++/JS-only usage) and M8 (Python activation-to-first-completion from cold offscreen).
- **Latency gate from spec D4:** boot triggers at first Python `DOC_SYNC` (model activation). If first-completion latency > 1 s after boot, document the gap; if > 3 s, revert this ticket to eager-with-teardown (eager boot retained, idle teardown added) and record the decision.

**Gate:** existing engine-host/backend tests pass; M7 shows zero pyright cost for non-Python usage; D4 latency decision recorded either way.

## P3.1-5 — Ping-free request path (spec F6 / D5)

**Status:** IMPLEMENTED — the per-feature ping and permanent cleanup failure path are removed; exact-build reload and M9 wall-time checks remain blocked.

- `entrypoints/monaco-hook.content.ts`: remove `pingBridge()` from `requestFeature()`; the 10 s request timeout is the liveness bound. Bridge `PING` handling may remain in the protocol; nothing sends it per-request.
- Failure semantics: bridge outage fails individual requests (providers already return empty results on error) and never calls `cleanup()`. Remaining `cleanup()` triggers: page unload, fresh-hook re-entry (`__leetsense_cleanup`).
- Live-verify the extension-reload chain now that ping timeout no longer tears down: reload extension → pending requests fail via `ctx.onInvalidated` → re-injected hook replaces the stale one → features work again.

**Gate:** M9 shows one round trip removed with no regression; extension-reload live check passes; no permanent-death path short of page unload.

## P3.1-6 — Measurement + verification closeout (spec §5, §6 / D6)

**Status:** AUTOMATED CLOSEOUT COMPLETE; LIVE M1/M3–M6/M8/M9 AND FEATURE REGRESSION PASS BLOCKED

- Record all M1–M9 before/after values (before values captured from `main` prior to merging P3.1-1…5, or from a pre-phase build kept for this purpose).
- Re-run phase 1 + phase 2 live verification feature checks on the packaged build (Python four features, C++ four features incl. Sema gate, JS/TS diagnostics, language switching, crash/reboot).
- Write `docs/specs/phase-3.1-verification.md`; update `docs/05-roadmap-and-risks.md` memory/latency rows, `CLAUDE.md`/`AGENTS.md` status lines, and the docs index.

**Gate:** every acceptance criterion in spec §6 checked; docs match shipped reality.
