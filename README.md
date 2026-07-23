# Energy Topology

Diagnose and repair the device topology of the Home Assistant Energy dashboard.
Detects cycles, missing parents and double-counting in your upstream
(`included_in_stat`) relationships. Read-only today, safe editing next.

> Status: **v0.5.0**. Admins can edit the topology (add / re-parent / remove)
> with preview and one-level undo; everyone else gets a read-only view.

## Why this exists

The native Energy dashboard (and its Sankey / "Energy flow" chart) already
*shows* how your devices consume energy. What it does not do is tell you when the
underlying hierarchy is **wrong**: a device pointing at a parent that no longer
exists, a self-reference, an accidental loop, or a sub-device that ends up
double-counted. Energy Topology reads that hierarchy and surfaces those problems.

The relationship is a real Home Assistant concept: each individual device can be
declared as *included in* another device (`included_in_stat`) to avoid counting
its consumption twice. Every device has at most one such parent, so the structure
is a **forest** (a set of trees), not an arbitrary graph.

## What it does

- reads the Energy prefs server-side (no polling, no writes);
- builds the device tree from `device_consumption` using `included_in_stat`;
- flags **missing parents** (upstream device not found);
- flags **self-references** (a device declared as its own parent);
- flags **cycles** (A → B → A);
- treats aggregating nodes as **panels / zones** and labels them by tier
  (primary / secondary / tertiary = depth in the tree);
- lets an admin **mark a childless sub-meter as a panel** (e.g. a floor
  sub-panel with nothing attached yet) so it shows as a zone; marks are stored
  separately and never touch the Energy config;
- enriches every device with its **area and floor**, resolved from the Home
  Assistant registries (statistic → entity → device → area → floor), and shows
  the rooms each panel directly covers;
- lets an admin **edit the topology** (add a tracked device, change its parent
  panel, remove it) in a draft, with a preview and a one-level undo; the write
  goes through the official `energy/save_prefs` path and only touches
  `device_consumption`;
- lets you search by name, `statistic_id` or room.

Location is used as information only, never for validation: a panel or meter
legitimately sits in a technical room, so comparing its area to its children's
areas would be unsound.

The topology building and validation run in a Python WebSocket command
(`energy_topology/get`); the panel is a thin view over it. A second command
(`energy_topology/preview`) validates a proposed `device_consumption` list
without writing, as groundwork for the future edit mode.

## Install (manual)

1. Copy `custom_components/energy_topology` into `/config/custom_components/`.
2. Restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration**.
4. Search for **Energy Topology**.
5. Open **Topologie énergie** in the sidebar.

See [INSTALLATION.md](INSTALLATION.md) for details and troubleshooting.

## Editing safely

Editing was added only after the model was validated and behind three
safeguards: it is admin-only, every change is validated and previewed before
being applied (a structural error blocks the write), and the previous state is
snapshotted so a single **undo** can restore it. Writes go through the official
`energy/save_prefs` path and only touch `device_consumption`; energy sources and
water consumption are preserved.

## Known limitations

- only electrical consumption from `device_consumption` is shown;
- external statistics and stats not bound to a device resolve to no area/floor
  (shown as "non localisé");
- validation is structural only (cycle / missing parent / self-reference);
  quantitative parent-vs-children comparison is not implemented yet;
- room-per-panel is derived from direct leaf children and is heuristic (depends
  on devices being assigned to areas);
- undo is one level deep (restores the state before the last apply).

## Roadmap

- **v0.2** — *(done)* backend WebSocket API, area/floor enrichment.
- **v0.3** — *(done)* panels/zones tiers (primary/secondary/tertiary), rooms per
  panel; removed the unsound cross-area/cross-floor rule.
- **v0.4** — *(done)* manual panel marks for childless sub-meters (admin, stored
  separately).
- **v0.5** — *(done)* edit mode: add / re-parent / remove devices with preview
  and one-level undo, admin only, via `save_prefs`.
- **v0.6** — *(done)* quantitative validation: flag a panel whose direct
  children consume more than the panel over 30 days (double-count / mis-parent).
- **v0.7** — *(done)* guided add picker: filter candidate statistics by typology
  (daily / monthly / yearly) then by room before choosing the entity.
- **v0.8** — *(done)* room coverage: per area, list energy devices not tracked
  in `device_consumption` (heuristic, deduped by device).
- **v1.0** — HACS default-repository publication.

## Contributing / feedback

Issues, screenshots and error logs are welcome:
<https://github.com/tazelbaze/ha-energy-topology/issues>.

## License

MIT — see [LICENSE](LICENSE).
