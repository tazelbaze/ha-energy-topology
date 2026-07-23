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

from .topology import build_nodes, validate

DATA_WS_REGISTERED = "energy_topology_ws_registered"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the WebSocket commands once."""
    if hass.data.get(DATA_WS_REGISTERED):
        return
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_preview)
    hass.data[DATA_WS_REGISTERED] = True


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
    issues = validate(nodes, locations)

    payload_nodes = []
    for node in nodes.values():
        loc = locations.get(node["id"], {})
        payload_nodes.append(
            {
                "id": node["id"],
                "name": node["name"],
                "parent_id": node["parent_id"],
                "rate_id": node["rate_id"],
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
