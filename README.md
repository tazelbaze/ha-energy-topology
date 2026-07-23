# Energy Topology

Diagnose and repair the device topology of the Home Assistant Energy dashboard.
Detects cycles, missing parents and double-counting in your upstream
(`included_in_stat`) relationships. Read-only today, safe editing next.

> Status: **v0.4.0**. Read-only on the Energy configuration; admins can mark
> nodes as panels (stored separately, never touching the Energy config).

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
- lets you search by name, `statistic_id` or room;
- never changes your Energy configuration.

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

## Why read-only first

Editing (`energy/save_prefs`) will come only once the model is validated and a
preview / undo flow is in place. Shipping read-only first guarantees this
integration cannot break an existing setup.

## Known limitations

- only electrical consumption from `device_consumption` is shown;
- external statistics and stats not bound to a device resolve to no area/floor
  (shown as "non localisé");
- validation is structural only (cycle / missing parent / self-reference);
  quantitative parent-vs-children comparison is not implemented yet;
- room-per-panel is derived from direct leaf children and is heuristic (depends
  on devices being assigned to areas);
- read-only: no editing of `included_in_stat` yet.

## Roadmap

- **v0.2** — *(done)* backend WebSocket API, area/floor enrichment.
- **v0.3** — *(done)* panels/zones tiers (primary/secondary/tertiary), rooms per
  panel; removed the unsound cross-area/cross-floor rule.
- **v0.4** — *(done)* manual panel marks for childless sub-meters (admin, stored
  separately).
- **v0.5** — safe edit mode: add and re-parent devices from the panel, with
  preview and undo before writing `save_prefs` (admin only).
- **v0.6** — room coverage: per area, list energy devices not tracked in
  `device_consumption` (heuristic candidates).
- **v0.7** — quantitative validation: parent vs sum of children over a period.
- **v1.0** — HACS default-repository publication.

## Contributing / feedback

Issues, screenshots and error logs are welcome:
<https://github.com/tazelbaze/ha-energy-topology/issues>.

## License

MIT — see [LICENSE](LICENSE).
