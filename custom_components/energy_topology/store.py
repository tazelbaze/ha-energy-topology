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
    """Store the set of statistic ids manually marked as panels/zones."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self._store: Store[dict] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._ids: set[str] = set()

    async def async_load(self) -> None:
        """Load marks from disk."""
        data = await self._store.async_load()
        self._ids = set((data or {}).get("panels", []))

    @property
    def ids(self) -> set[str]:
        """Return a copy of the marked ids."""
        return set(self._ids)

    async def async_set(self, statistic_id: str, is_panel: bool) -> None:
        """Mark or unmark a statistic id as a panel and persist."""
        if is_panel:
            self._ids.add(statistic_id)
        else:
            self._ids.discard(statistic_id)
        await self._store.async_save({"panels": sorted(self._ids)})

    async def async_prune(self, valid_ids: set[str]) -> None:
        """Drop marks that no longer match an existing statistic id."""
        pruned = self._ids & valid_ids
        if pruned != self._ids:
            self._ids = pruned
            await self._store.async_save({"panels": sorted(self._ids)})


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
