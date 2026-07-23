"""WebSocket API for Energy Topology.

Exposes the topology as a server-side command so the logic lives in Python
(testable, reusable) instead of the frontend. Read-only: ``get`` reads the
Energy prefs, ``preview`` validates a proposed device_consumption list without
writing anything.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.energy.data import async_get_manager
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
    floor_registry as fr,
)

from .const import DOMAIN
from .topology import annotate, build_nodes, validate

DATA_WS_REGISTERED = "energy_topology_ws_registered"
DATA_PANEL_STORE = "panel_store"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the WebSocket commands once."""
    if hass.data.get(DATA_WS_REGISTERED):
        return
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_preview)
    websocket_api.async_register_command(hass, ws_set_panel)
    hass.data[DATA_WS_REGISTERED] = True


@callback
def _panel_ids(hass: HomeAssistant) -> set[str]:
    """Return the set of statistic ids manually marked as panels."""
    store = hass.data.get(DOMAIN, {}).get(DATA_PANEL_STORE)
    return store.ids if store is not None else set()


@callback
def _resolve_locations(
    hass: HomeAssistant, node_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Resolve each statistic id to its area and floor via the registries.

    A device_consumption statistic id is an entity id when it comes from a
    Home Assistant entity. External statistics (``domain:object``) and stats
    not bound to a device/area resolve to an empty location.
    """
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)
    floor_reg = fr.async_get(hass)

    result: dict[str, dict[str, Any]] = {}
    for node_id in node_ids:
        loc: dict[str, Any] = {
            "area_id": None,
            "area_name": None,
            "floor_id": None,
            "floor_name": None,
        }
        area_id: str | None = None
        entity = ent_reg.async_get(node_id)
        if entity is not None:
            area_id = entity.area_id
            if area_id is None and entity.device_id:
                device = dev_reg.async_get(entity.device_id)
                if device is not None:
                    area_id = device.area_id

        if area_id:
            area = area_reg.async_get_area(area_id)
            if area is not None:
                loc["area_id"] = area.id
                loc["area_name"] = area.name
                if area.floor_id:
                    floor = floor_reg.async_get_floor(area.floor_id)
                    if floor is not None:
                        loc["floor_id"] = floor.floor_id
                        loc["floor_name"] = floor.name
        result[node_id] = loc
    return result


def _build_payload(
    hass: HomeAssistant, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """Build the nodes + issues payload from a device_consumption list."""
    nodes = build_nodes(items)
    locations = _resolve_locations(hass, list(nodes.keys()))
    annotate(nodes, locations, _panel_ids(hass))
    issues = validate(nodes)

    payload_nodes = []
    for node in nodes.values():
        loc = locations.get(node["id"], {})
        payload_nodes.append(
            {
                "id": node["id"],
                "name": node["name"],
                "parent_id": node["parent_id"],
                "rate_id": node["rate_id"],
                "is_panel": node["is_panel"],
                "has_children": node["has_children"],
                "manual_panel": node["manual_panel"],
                "tier": node["tier"],
                "rooms": node["rooms"],
                "area_id": loc.get("area_id"),
                "area_name": loc.get("area_name"),
                "floor_id": loc.get("floor_id"),
                "floor_name": loc.get("floor_name"),
            }
        )
    return {"nodes": payload_nodes, "issues": issues}


@websocket_api.websocket_command({vol.Required("type"): "energy_topology/get"})
@websocket_api.async_response
async def ws_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the current topology (read-only)."""
    manager = await async_get_manager(hass)
    data = manager.data or {}
    items = data.get("device_consumption", []) or []
    connection.send_result(msg["id"], _build_payload(hass, items))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "energy_topology/preview",
        vol.Required("device_consumption"): [dict],
    }
)
@websocket_api.async_response
async def ws_preview(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Validate a proposed device_consumption list without writing it."""
    payload = _build_payload(hass, msg["device_consumption"])
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "energy_topology/set_panel",
        vol.Required("statistic_id"): str,
        vol.Required("is_panel"): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_panel(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Mark or unmark a node as a panel/zone (admin only), then return the topology."""
    store = hass.data.get(DOMAIN, {}).get(DATA_PANEL_STORE)
    if store is None:
        connection.send_error(msg["id"], "not_ready", "Panel store not initialised")
        return
    await store.async_set(msg["statistic_id"], msg["is_panel"])
    manager = await async_get_manager(hass)
    data = manager.data or {}
    items = data.get("device_consumption", []) or []
    connection.send_result(msg["id"], _build_payload(hass, items))
