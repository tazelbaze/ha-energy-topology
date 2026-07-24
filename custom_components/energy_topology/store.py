"""Persistence for manual panel/zone marks.

Home Assistant's energy prefs schema is strict and rejects extra keys, so the
"this node is an electrical panel" flag cannot live there. It is kept in a small
dedicated store, holding only a set of statistic ids marked as panels. The
topology relationships themselves stay in the energy config.
"""
from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

STORAGE_KEY = f"{DOMAIN}.panels"
SNAPSHOT_KEY = f"{DOMAIN}.snapshot"
STORAGE_VERSION = 1


class PanelStore:
    """Store manual overrides deciding whether a node is a panel/zone.

    Two sets are kept:
    - ``panels``: ids forced to be a panel even with no children (an empty
      sub-meter).
    - ``appliances``: ids forced to NOT be a panel even with children (e.g. a
      smart plug measuring a device plugged into it: a parent for double-count
      purposes, but not an electrical panel).
    """

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self._store: Store[dict] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._panels: set[str] = set()
        self._appliances: set[str] = set()

    async def async_load(self) -> None:
        """Load marks from disk."""
        data = await self._store.async_load() or {}
        self._panels = set(data.get("panels", []))
        self._appliances = set(data.get("appliances", []))

    @property
    def panel_ids(self) -> set[str]:
        """Ids forced to be panels."""
        return set(self._panels)

    @property
    def appliance_ids(self) -> set[str]:
        """Ids forced to not be panels."""
        return set(self._appliances)

    async def _save(self) -> None:
        await self._store.async_save(
            {"panels": sorted(self._panels), "appliances": sorted(self._appliances)}
        )

    async def async_set(self, statistic_id: str, is_panel: bool) -> None:
        """Force a node to be a panel (True) or an appliance (False)."""
        if is_panel:
            self._panels.add(statistic_id)
            self._appliances.discard(statistic_id)
        else:
            self._panels.discard(statistic_id)
            self._appliances.add(statistic_id)
        await self._save()

    async def async_prune(self, valid_ids: set[str]) -> None:
        """Drop marks that no longer match an existing statistic id."""
        panels = self._panels & valid_ids
        appliances = self._appliances & valid_ids
        if panels != self._panels or appliances != self._appliances:
            self._panels = panels
            self._appliances = appliances
            await self._save()


class SnapshotStore:
    """Keep a single snapshot of device_consumption for one-level undo."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the snapshot store."""
        self._store: Store[dict] = Store(hass, STORAGE_VERSION, SNAPSHOT_KEY)
        self._data: dict | None = None

    async def async_load(self) -> None:
        """Load the snapshot from disk."""
        self._data = await self._store.async_load()

    @property
    def has_snapshot(self) -> bool:
        """Whether a snapshot is available to restore."""
        return bool(self._data and "device_consumption" in self._data)

    @property
    def device_consumption(self) -> list[dict]:
        """Return the snapshotted device_consumption list."""
        return list((self._data or {}).get("device_consumption", []))

    async def async_save_snapshot(self, items: list[dict]) -> None:
        """Store a snapshot of the given device_consumption list."""
        self._data = {"device_consumption": list(items)}
        await self._store.async_save(self._data)

    async def async_clear(self) -> None:
        """Drop the snapshot."""
        self._data = None
        await self._store.async_remove()
