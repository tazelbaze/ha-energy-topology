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
from .topology import (
    annotate,
    build_nodes,
    check_quantities,
    sanitize_items,
    validate,
)

DATA_WS_REGISTERED = "energy_topology_ws_registered"
DATA_PANEL_STORE = "panel_store"
DATA_SNAPSHOT_STORE = "snapshot_store"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the WebSocket commands once."""
    if hass.data.get(DATA_WS_REGISTERED):
        return
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_preview)
    websocket_api.async_register_command(hass, ws_set_panel)
    websocket_api.async_register_command(hass, ws_save)
    websocket_api.async_register_command(hass, ws_undo)
    websocket_api.async_register_command(hass, ws_check_quantities)
    hass.data[DATA_WS_REGISTERED] = True


@callback
def _panel_ids(hass: HomeAssistant) -> set[str]:
    """Return the set of statistic ids manually marked as panels."""
    store = hass.data.get(DOMAIN, {}).get(DATA_PANEL_STORE)
    return store.ids if store is not None else set()


@callback
def _can_undo(hass: HomeAssistant) -> bool:
    """Whether a previous device_consumption snapshot is available."""
    snap = hass.data.get(DOMAIN, {}).get(DATA_SNAPSHOT_STORE)
    return bool(snap and snap.has_snapshot)


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
    return {"nodes": payload_nodes, "issues": issues, "items": items}


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
    result = _build_payload(hass, items)
    result["can_undo"] = _can_undo(hass)
    connection.send_result(msg["id"], result)


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
    result = _build_payload(hass, items)
    result["can_undo"] = _can_undo(hass)
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "energy_topology/save",
        vol.Required("device_consumption"): [dict],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Write a new device_consumption list (admin only), after validation.

    Snapshots the previous list so the change can be undone. Refuses to write if
    the proposed topology has a structural error.
    """
    items = sanitize_items(msg["device_consumption"])
    errors = [i for i in validate(build_nodes(items)) if i["severity"] == "error"]
    if errors:
        connection.send_error(msg["id"], "invalid_topology", errors[0]["message"])
        return

    snap = hass.data.get(DOMAIN, {}).get(DATA_SNAPSHOT_STORE)
    manager = await async_get_manager(hass)
    previous = list((manager.data or {}).get("device_consumption", []) or [])
    if snap is not None:
        await snap.async_save_snapshot(previous)
    await manager.async_update({"device_consumption": items})

    result = _build_payload(hass, items)
    result["can_undo"] = _can_undo(hass)
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "energy_topology/undo"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_undo(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Restore the last snapshot of device_consumption (admin only)."""
    snap = hass.data.get(DOMAIN, {}).get(DATA_SNAPSHOT_STORE)
    if snap is None or not snap.has_snapshot:
        connection.send_error(msg["id"], "no_snapshot", "Aucun état précédent à restaurer")
        return

    items = snap.device_consumption
    manager = await async_get_manager(hass)
    await manager.async_update({"device_consumption": items})
    await snap.async_clear()

    result = _build_payload(hass, items)
    result["can_undo"] = _can_undo(hass)
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "energy_topology/check_quantities",
        vol.Required("consumption"): dict,
    }
)
@websocket_api.async_response
async def ws_check_quantities(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Compare each panel to the sum of its children over a period.

    The measured consumption per statistic id is supplied by the caller (fetched
    from the recorder in the frontend); the comparison logic stays in Python.
    """
    manager = await async_get_manager(hass)
    items = (manager.data or {}).get("device_consumption", []) or []
    nodes = build_nodes(items)
    consumption: dict[str, float] = {}
    for key, value in msg["consumption"].items():
        if value is None:
            continue
        try:
            consumption[key] = float(value)
        except (TypeError, ValueError):
            continue
    issues = check_quantities(nodes, consumption)
    connection.send_result(msg["id"], {"issues": issues})
