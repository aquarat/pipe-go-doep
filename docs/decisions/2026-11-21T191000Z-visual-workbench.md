# Score and rack workbench

Date: 2026-11-21T19:10:00Z
Status: accepted

## Context

The maintainer asked for separate score and patch visualisations, a collapsed JSON
tree, project-associated pane persistence, and a Reason-like rack with module
function icons and explicit mixer/control visualisation.

## Decision

Implement dependency-free native ES modules for a score tracker/piano roll, an
SVG/CSS hardware-style rack and a lazy JSON tree. CSS provides faceplate depth,
knobs and rails; SVG/Canvas provides graphical data and connections. This keeps
text sharp and leaves the Go binary self-contained, while supporting rack-style
interaction without a 3D runtime or graphics assets.

The browser app owns the project, transport and persistence. Visual components
receive the project read-only and return view-state changes or JSON Pointer
selection requests. The JSON tree edits scalar fields; structural changes use
validated source mode. Both visual panes can reveal corresponding project data.

Each project has a UUID. Pane and visual preferences are browser-local per UUID;
tree expansion is project metadata. Missing expansion entries mean collapsed.
Tree metadata and identity are excluded from the render-staleness signature.
Browser drafts are stored separately for each project rather than overwriting
one global draft on project changes.

## Consequences

The visual rack shows available module controls, including unconnected defaults
and cabled controls, as well as mixer channels. It is a visualisation of the
stored patch, not a second live DSP implementation. Rendered audio remains an
offline snapshot, and no per-module signal meters are fabricated.

The source tree is economical for long scores because closed branches do not
construct child DOM. Tree paths into arrays are positional; reorganising arrays
may shift the content associated with a remembered path. Browser storage is
origin-local, so workspaces at localhost and the LAN IP are independent.
