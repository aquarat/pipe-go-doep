# ADR: project identity and portable JSON-tree metadata

- Date: 2026-11-21T19:03:09Z
- Status: accepted
- Scope: `internal/score`, example scores, browser state contract

## Context

The visual workbench needs stable per-project pane preferences and a JSON tree
whose expansion state survives saving and reopening. Existing version-1 scores
must remain usable, and editor state must not alter music or deterministic DSP.

## Decision

Add optional `Document.ID string` (`id,omitempty`) and `Document.UI *UIState`
(`_ui,omitempty`) to version 1. This is an additive, backward-compatible schema
extension; the version remains 1. The parser accepts missing or empty identity.
When nonempty, identity must match the hyphenated 8-4-4-4-12 hexadecimal UUID
shape with version 1–8 and variant 8/9/a/b. Accept either letter case and preserve
the supplied value. The browser generates a UUID when loading a legacy project;
Go parsing never invents or replaces identity. Store a generated, stable v4 UUID
in each bundled example without changing musical content.

`UIState.TreeExpanded []string` (`tree_expanded,omitempty`) records expanded
JSON-tree rows as JSON Pointers. The empty string names the root. All rows default
to collapsed unless listed. Validate slash-prefixed non-root paths and only
`~0`/`~1` tilde escapes; reject duplicate paths. Bound this list to 4096 entries
of at most 1024 bytes each, inside the existing 4 MiB document cap. Do not require
paths to resolve: stale expansion state after a document edit is harmless.
Keep the decoder's strict unknown-field rejection inside `_ui` as elsewhere.

Persist tree expansion in project JSON. Persist pane visibility and component
view preferences in browser storage under the document UUID, following
`docs/workbench-components.md`. Identity and UI metadata have no role in note
scheduling, graph compilation, random seeding, or audio rendering.

## Consequences

- Existing identity-free documents retain their Go parse/marshal behavior;
  browser saves can upgrade them with identity without a format migration.
- Project copies retaining their UUID share browser-local view preferences.
  A separately identified project needs a newly assigned UUID.
- Tree state follows an exported project while browser-specific pane preferences
  stay local to that browser and identity.
- Metadata validation is bounded and applies to direct Go callers as well as
  JSON parsing. Unknown future metadata fields require an explicit schema update.
- Tests cover legacy and metadata round trips, identity case preservation, UUID
  versions/variants, pointer escapes, duplicate/size rejection, unknown fields,
  and byte-identical example render excerpts with and without metadata.
