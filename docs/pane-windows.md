# Pane windows

`internal/workbench/static/pane-windows.js` moves the existing non-summary
children of a top-level `<details data-pane="…">` into a same-origin popup.
Node identity, DOM listeners, input values and the parent's application model
remain intact. No app scripts or storage writers are started in the child.

## Coordinator integration

Load `pane-windows.css` after the component stylesheets in the main page. Cache
element references before creating the coordinator: parent `getElementById()`
cannot find nodes while they belong to a child document.

```js
import { createPaneWindows } from './pane-windows.js';

const paneWindows = createPaneWindows({
  panes: [...document.querySelectorAll('.workspace > details[data-pane]')],
  onLayout(name) {
    if (name === 'score') scoreView.refreshLayout();
    if (name === 'rack') rackView.refreshLayout();
  },
  onError(message) { showStatus(message); },
  onChange(name, detached) { /* Optional UI notification. */ },
});
```

The exact returned API is `{ popOut, dock, dockAll, refresh, destroy }`:

- `popOut(name)` opens synchronously from a user gesture and returns success as
  a boolean. An already detached pane is focused. Blocked popups report a readable
  error without changing the pane, its collapse state or its content.
- `dock(name)` returns whether a child was docked. Main-summary, parent-placeholder
  and child-header buttons all use this same operation.
- `dockAll()` restores all panes and closes their children. Call this before
  switching projects or replacing top-level pane content.
- `refresh()` invokes layout for each pane and reconciles closed children.
- `destroy()` docks all panes and removes controls, listeners and queued frames;
  repeated calls are harmless. Destroy components after the coordinator.

Summary buttons prevent default click behavior and stop propagation, retaining
native Enter/Space activation. Clicking the rest of the summary still toggles
the original `<details>`. Detachment does not force it open or closed.

## Child structure and lifecycle

```text
html (parent language/classes)
  head
    title (text only), base (parent URL), viewport meta
    copies of the parent's stylesheet links and style elements
  body.pane-window
    header.pane-window-header
      h1.pane-window-title
      button: Pop in
    main.pane-window-main                 [scrollable remaining window height]
      section.pane-window-content[data-pane]  [original pane classes]
        actual adopted content nodes     [original IDs, events and values]
```

The parent keeps its original summary, small sibling-position comments, and a
`.pane-window-placeholder` with a Pop in button. Docking restores original
sibling order and includes content added to the child container. All headings
use `textContent`; no project text is passed through `document.write` or HTML
parsing. Child markup contains no duplicate app or component instance.

`onLayout(name)` runs immediately after adoption so components can rebind their
host, again on its next animation frame, after linked stylesheets settle, and
on child resize. Components must measure their current owner document. The score
view cancels old-window frames, rebinds resize/visibility listeners and its
ResizeObserver, and reads DPR/styles/rAF from its current host. Hidden documents
do not schedule score draws. Musical timeline logic is unchanged.

The child main region scrolls the natural content height. The rack's measured
spacer retains the full rack height instead of inheriting a fixed 72vh viewport;
its horizontal overflow remains accessible. Child close/navigation docks content
through `beforeunload`/`pagehide`; parent unload docks and closes every child.
Explicit docking removes those listeners before closing the window, avoiding
reentrant transitions. Pending frames and stylesheet/button/resize listeners
are cleaned up. Media elements keep their identity, position and play state;
failed browser playback resumption is reported via `onError`.

## Browser verification

Use an existing external Playwright installation; no project dependency install
or running workbench server is needed. Tests serve the current source files on
an ephemeral loopback port.

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chrome \
node --test internal/workbench/static/pane-windows.browser.mjs \
  internal/workbench/static/score-view.test.mjs
```

The five browser scenarios cover actual-node identity and retained controls,
keyboard/summary behavior, delayed CSS layout, full rack scrolling, independent
children, close/pop-in/dockAll/destroy, blocked popups, current-window score
frames/DPR/resize, active audio adoption, and parent-close cleanup. On Linux,
Chromium's socket path requires a short `TMPDIR`; a short symlink to a longer
temporary directory works without relocating test artifacts.
