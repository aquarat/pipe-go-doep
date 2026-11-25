# 2026-11-21T19:50:00Z — Run the existing Go engine in a browser worker

Status: accepted.

## Context

Public static-assets hosting cannot invoke the native Go HTTP renderer. The
workbench must retain the existing score format, validation, DSP behavior and WAV
metadata while remaining interactive during synthesis. Native CLI/LAN operation
must continue using its current HTTP interface.

## Decision

Compile a build-tagged `cmd/pipe-go-doep-wasm` executable using the standard Go
`js/wasm` target. Reuse the existing parser, compiler and renderer without DSP
changes. Run it inside a classic dedicated Web Worker with the toolchain-matched
`wasm_exec.js`, exposing one retained `syscall/js` bridge callback. Copy completed
WAV bytes out of Go memory and transfer their ArrayBuffer to the UI.

Hide backend selection behind `synthRequest`, returning real browser Responses.
Cache explicit `/api/runtime` discovery, preserve native JSON POST requests, and
initialize WASM lazily. Enforce native workbench budgets and reject overlapping
browser operations with 429. Main-thread deadlines terminate stuck workers and
allow subsequent requests to start a clean runtime.

Build only public runtime assets and examples into `dist/`. Use narrowly scoped
CSP permissions (`wasm-unsafe-eval`, same-origin workers and connections); no
third-party synthesizer, credentials or private render endpoint is introduced.

## Consequences

The browser downloads a Go runtime and performs synthesis on the user's CPU.
Worker isolation keeps rendering off the UI thread; bounded copies temporarily
increase peak memory. Fatal or timed-out work loses that worker's state, which is
safe because each request contains a complete score. Browser Go floating-point
behavior is checked against native PCM output on a representative short fixture.
Native tests remain ordinary host builds because the WASM command is excluded.

See [browser-renderer.md](../browser-renderer.md) for protocol, build, CSP and
verification details.
