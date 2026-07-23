# Energy Topology

Diagnose and repair the device topology of the Home Assistant Energy dashboard.
Detects cycles, missing parents and double-counting in your upstream
(`included_in_stat`) relationships. Read-only today, safe editing next.

> Status: **v0.1.0 — read-only**. This version cannot modify your Energy
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

## What v0.1.0 does

- reads `energy/get_prefs` over WebSocket (no polling, no writes);
- builds the device tree from `device_consumption` using `included_in_stat`;
- flags **missing parents** (upstream device not found);
- flags **self-references** (a device declared as its own parent);
- flags **cycles** (A → B → A);
- lets you search by name or `statistic_id`;
- never changes your Energy configuration.

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
- external statistics may not have a friendly label;
- validation is structural only (cycles / orphans / self-parent); quantitative
  parent-vs-children comparison is not implemented yet;
- all logic currently runs in the frontend — moving it to a Python WebSocket
  command is a planned refactor (see [docs/RFC.md](docs/RFC.md)).

## Roadmap

- **v0.2** — quantitative validation: compare a parent's consumption against the
  sum of its children over a period, to catch real double-counting.
- **v0.3** — backend WebSocket API (`energy_topology/get`) so the logic is
  testable server-side.
- **v0.4** — safe edit mode: draft, preview, undo before writing `save_prefs`.
- **v1.0** — HACS default-repository publication.

## Contributing / feedback

Issues, screenshots and error logs are welcome:
<https://github.com/tazelbaze/ha-energy-topology/issues>.

## License

MIT — see [LICENSE](LICENSE).
