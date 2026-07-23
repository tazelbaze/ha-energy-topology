"""Energy Topology integration."""
from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import (
    DOMAIN,
    FRONTEND_URL,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    STATIC_PATH,
)
from .store import PanelStore, SnapshotStore
from .websocket_api import (
    DATA_PANEL_STORE,
    DATA_SNAPSHOT_STORE,
    async_register as async_register_ws,
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Energy Topology from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if DATA_PANEL_STORE not in domain_data:
        store = PanelStore(hass)
        await store.async_load()
        domain_data[DATA_PANEL_STORE] = store
    if DATA_SNAPSHOT_STORE not in domain_data:
        snapshot = SnapshotStore(hass)
        await snapshot.async_load()
        domain_data[DATA_SNAPSHOT_STORE] = snapshot

    async_register_ws(hass)

    frontend_path = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_PATH, str(frontend_path), False)]
    )

    # Append the integration version so the browser reloads the panel JS after
    # every update instead of serving a stale cached module.
    integration = await async_get_integration(hass, DOMAIN)
    module_url = f"{FRONTEND_URL}?v={integration.version}"

    frontend.async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL,
        config={
            "_panel_custom": {
                "name": "energy-topology-panel",
                "module_url": module_url,
                "embed_iframe": False,
                "trust_external": False,
            }
        },
        require_admin=False,
    )
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = True
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload Energy Topology."""
    frontend.async_remove_panel(hass, PANEL_URL)
    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return True
