# Interactive rack and detachable panes

Date: 2026-11-21T19:40:00Z
Status: accepted; extends the visual-workbench decision

## Context

The maintainer requested draggable controls and cable endpoints, precise links to
control JSON even when defaults were omitted, full rack extent, and separate
browser windows for collapsible panes.

## Decision

Create a shared client module catalogue and pure project-edit functions. Materialise
known constructor defaults on browser project load without replacing explicit
values. Control gestures preview locally, then commit bounded values on release;
clicks reveal the exact scalar JSON path. Cable changes clone a candidate and
check direction, occupied inputs and cycles; the Go compiler validates routing
before commit. A revision check rejects responses for a superseded project state.

The rack uses the full pane width and expands vertically to contain every module
instance. Pages and popup windows provide vertical scrolling instead of a short
fixed-height rack viewport.

Detach panes by moving their actual DOM content into same-origin windows, retaining
listeners, inputs, media and one authoritative project model. Cache app element
references and refresh component layout/window-dependent behaviour after adoption.
Closing a child, changing projects or unloading the parent docks the panes.

## Consequences

Exported projects include default parameter values, making the patch more verbose
but inspectable. A patched input's dial edits its base value, not the signal on its
cable. All audible changes still require offline rendering.

Detached windows share the parent's lifecycle and are not independent application
copies. This avoids broadcast-state races and duplicate playback/localStorage
writers. Browser popup blocking is reported without moving or losing pane content.
