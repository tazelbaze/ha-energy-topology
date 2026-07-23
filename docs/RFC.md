# Energy Topology — Design note (RFC v1)

Short, living design document. It records decisions, not aspirations. Sections
grow only when a real decision is made.

## 1. Problem

The Home Assistant Energy dashboard lets each individual device be declared as
*included in* another device (`included_in_stat`) to avoid double-counting. There
is no tool to inspect that hierarchy as a whole, nor to detect when it is broken
(missing parent, self-reference, cycle) or quantitatively inconsistent
(a parent whose declared consumption is smaller than the sum of its children).
The native Sankey / "Energy flow" chart visualises consumption but does not
validate the topology.

## 2. Goal

Make the energy topology a first-class, inspectable and (later) editable object:
read the relationships, validate them, and eventually fix them safely without
risking the existing Energy configuration.

## 3. Scope

**In scope (now):** read-only inspection of `device_consumption`; structural
validation (missing parent, self-reference, cycle); search.

**In scope (later):** quantitative validation over a period; a backend WebSocket
API; a guarded edit mode with preview and undo.

**Out of scope:** replacing the native Sankey chart; multi-parent relationships
(HA supports a single `included_in_stat` per device — see open questions);
non-electrical energy sources.

## 4. Data model

The prefs entry `device_consumption` is a list of items with at least:

- `stat_consumption` — the device's statistic id (node id);
- `included_in_stat` — optional parent statistic id (single value);
- `name` — optional friendly label.

Because each node has at most one parent, the structure is a **forest**, not a
DAG. Editing and validation logic should assume single-parent trees.

Internal representation:

- **Node** `{ id, name, parentId, children[] }`
- **Issue** `{ severity, node, message }` where kind ∈
  `missing_parent | self_parent | cycle` (v0.1), extended with
  `quantitative_mismatch` in v0.2.

## 5. Validation rules

- **missing_parent** — `parentId` set but not present among the nodes.
- **self_parent** — `parentId == id`.
- **cycle** — following `parentId` pointers returns to an already-visited node
  (detected with a white/grey/black DFS).
- **quantitative_mismatch** *(later)* — over a chosen period, a parent's
  consumption is lower than the sum of its children's consumption (likely
  double-count or mis-attribution).

Location is **never** used for validation. A cross-area / cross-floor rule was
tried in v0.2 and dropped in v0.3: a parent is typically a meter or panel that
legitimately sits in a technical room, so comparing its area to its children's
areas produces false positives.

### Panels / zones and location model (v0.3)

A "zone" is a place with an electrical panel. A panel is an aggregating node of
the `included_in_stat` forest, and the panel hierarchy (primary → secondary →
tertiary) is exactly the topology tree. Each node is annotated with `tier`
(depth from the root), `rooms` (the areas of its direct appliance children) and
`is_panel = has_children or manually marked`.

A sub-meter that has no children (e.g. a floor sub-panel with nothing attached
yet) is structurally indistinguishable from an appliance, and HA's strict
`device_consumption` schema cannot carry a "this is a panel" flag (extra keys
are rejected by `save_prefs`). So an admin can mark such a node as a panel; the
mark is kept in a small dedicated store (`energy_topology.panels`), separate
from the Energy config, and is pruned when the statistic no longer exists.

Location is orthogonal to the topology and never stored in the Energy prefs.
Each node's area and floor are resolved live from the registries: statistic id →
entity → (entity area, else device area) → area → floor. Rooms are HA **Areas**;
HA **Floors** (RDC / Etage) are a separate axis and are not forced to equal a
zone. A room belongs to the zone whose panel feeds its appliances, derived from
the tree (heuristic).

## 6. Architecture decision

**Decision:** the topology building and validation logic will move from the
frontend into a Python WebSocket command (`energy_topology/get`).

**Why:** the current v0.1 runs entirely in the browser, which means the shipped
logic is not covered by the Python tests (they exercise a parallel
reimplementation), and a future edit flow calling `energy/save_prefs` from the
browser has no transactional safety. A backend command makes the logic testable,
reusable, and lets edit/preview/undo be handled server-side.

**Status:** done in v0.2. `energy_topology/get` returns the enriched topology
and issues; `energy_topology/preview` validates a proposed `device_consumption`
list without writing. The panel is now a thin view over these commands.

Home Assistant remains the source of truth for entities and statistics; this
integration only reads a derived view and (later) proposes edits back through the
official `save_prefs` path.

## 7. Security

The panel is visible to non-admins in read-only mode. Every write path
(`set_panel`, `save`, `undo`) is guarded by `require_admin`. `save` refuses a
draft with a structural error, snapshots the previous `device_consumption`, and
writes only that key through `manager.async_update`; `undo` restores the
snapshot. This keeps energy sources and water consumption untouched and makes
any change reversible one level deep.

## 8. Roadmap

- **v0.1** — read-only inspection + structural validation.
- **v0.2** — *(done)* backend WebSocket API (tests target the real logic),
  area/floor enrichment.
- **v0.3** — *(done)* panels/zones tiers + rooms per panel; dropped the unsound
  cross-area / cross-floor rule.
- **v0.4** — *(done)* manual panel marks for childless sub-meters (admin-only,
  kept in a dedicated store, `is_panel = has_children or marked`).
- **v0.5** — *(done)* guarded edit mode (add / re-parent / remove, draft,
  preview, one-level undo) via `save_prefs`, admin only.
- **v0.6** — room coverage: per area, list energy devices not tracked in
  `device_consumption` (heuristic candidates, not hard errors).
- **v0.7** — quantitative parent/children validation over a period.
- **v1.0** — HACS default-repository publication + full docs.

## 9. Open questions

- Multi-parent: HA currently allows a single `included_in_stat`. If that ever
  changes, the forest assumption (and edit logic) must be revisited.
- Deletion semantics: what happens to children when a parent device is removed.
- Export: is a Mermaid / Graphviz export worth it once the native Sankey exists?
- `device_consumption` schema stability across HA versions — to be re-checked on
  each major release.
