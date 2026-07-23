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
- **cross_floor / cross_area** *(v0.2)* — an `included_in_stat` link whose child
  and parent sit in different floors (resp. areas). Reported at most once per
  link, floor mismatch taking precedence. This is what breaks the native
  Sankey's floor/area grouping.
- **quantitative_mismatch** *(v0.4)* — over a chosen period, a parent's
  consumption is lower than the sum of its children's consumption (likely
  double-count or mis-attribution).

### Location model (v0.2)

Location is **orthogonal** to the topology and is never stored in the Energy
prefs. Each node's area and floor are resolved live from the registries:
statistic id → entity → (entity area, else device area) → area → floor. Rooms
are HA **Areas**; the "RDC / Etage" style groups and remote electrical panels
are HA **Floors** / floor-less Areas. A remote sub-panel is simply an upstream
device (an intermediate topology node), not a new concept.

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

v0.1 is read-only and the panel is non-admin. As soon as write capability is
added, the edit surface must be **admin-only** (`require_admin: true`) and every
write must go through a preview + explicit confirmation.

## 8. Roadmap

- **v0.1** — read-only inspection + structural validation.
- **v0.2** — *(done)* backend WebSocket API (tests target the real logic),
  area/floor enrichment, cross-area / cross-floor detection.
- **v0.3** — room coverage: per area, list energy devices not tracked in
  `device_consumption` (heuristic candidates, not hard errors).
- **v0.4** — quantitative parent/children validation over a period.
- **v0.5** — guarded edit mode (draft, preview, undo) via `save_prefs`.
- **v1.0** — HACS default-repository publication + full docs.

## 9. Open questions

- Multi-parent: HA currently allows a single `included_in_stat`. If that ever
  changes, the forest assumption (and edit logic) must be revisited.
- Deletion semantics: what happens to children when a parent device is removed.
- Export: is a Mermaid / Graphviz export worth it once the native Sankey exists?
- `device_consumption` schema stability across HA versions — to be re-checked on
  each major release.
