# Energy Topology

Diagnose and repair the device topology of the Home Assistant Energy dashboard.
Detects cycles, missing parents and double-counting in your upstream
(`included_in_stat`) relationships. Read-only today, safe editing next.

> Status: **v0.2.0 — read-only**. This version cannot modify your Energy
> configuration.

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
- enriches every device with its **area and floor**, resolved from the Home
  Assistant registries (statistic → entity → device → area → floor);
- flags **cross-area** and **cross-floor** attachments, i.e. an
  `included_in_stat` link that crosses a room or level boundary (the thing that
  breaks the native Sankey's floor/area grouping);
- lets you search by name, `statistic_id` or room;
- never changes your Energy configuration.

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
- validation is structural + location-boundary only; quantitative
  parent-vs-children comparison is not implemented yet (see roadmap);
- read-only: no editing of `included_in_stat` yet.

## Roadmap

- **v0.2** — *(done)* backend WebSocket API, area/floor enrichment, cross-area
  and cross-floor detection.
- **v0.3** — room coverage: per area, list energy devices that are not tracked
  in `device_consumption` (candidates, heuristic).
- **v0.4** — quantitative validation: compare a parent's consumption against the
  sum of its children over a period, to catch real double-counting.
- **v0.5** — safe edit mode: draft, preview, undo before writing `save_prefs`.
- **v1.0** — HACS default-repository publication.

## Contributing / feedback

Issues, screenshots and error logs are welcome:
<https://github.com/tazelbaze/ha-energy-topology/issues>.

## License

MIT — see [LICENSE](LICENSE).
