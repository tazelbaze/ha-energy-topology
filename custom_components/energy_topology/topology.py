"""Pure topology logic for Energy Topology.

This module has no Home Assistant imports so it can be unit-tested directly.
It builds the device forest from the Energy prefs ``device_consumption`` list,
validates its structure, and annotates each node as a panel/zone (an aggregating
node), with its tier (depth) and the rooms it directly covers.
"""
from __future__ import annotations

from typing import Any

# Issue kinds
MISSING_PARENT = "missing_parent"
SELF_PARENT = "self_parent"
CYCLE = "cycle"

# Keys accepted by Home Assistant's device_consumption schema.
_ALLOWED_KEYS = ("stat_rate", "name", "included_in_stat")


def sanitize_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return device_consumption entries limited to schema-valid keys.

    Drops entries without ``stat_consumption`` and any unknown key, so a draft
    coming from the frontend cannot inject fields that ``save_prefs`` would
    reject. Empty optional values are omitted.
    """
    clean: list[dict[str, Any]] = []
    for item in items:
        stat = item.get("stat_consumption")
        if not stat:
            continue
        entry: dict[str, Any] = {"stat_consumption": stat}
        for key in _ALLOWED_KEYS:
            value = item.get(key)
            if value:
                entry[key] = value
        clean.append(entry)
    return clean


def build_nodes(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Build a node map from a ``device_consumption`` list.

    Each node has a single optional parent (``included_in_stat``), so the
    resulting structure is a forest.
    """
    nodes: dict[str, dict[str, Any]] = {}
    for item in items:
        node_id = item.get("stat_consumption")
        if not node_id:
            continue
        nodes[node_id] = {
            "id": node_id,
            "name": item.get("name") or node_id,
            "parent_id": item.get("included_in_stat") or None,
            "rate_id": item.get("stat_rate") or None,
        }
    return nodes


def validate(nodes: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the structural issues found in the topology.

    Location (area/floor) is intentionally NOT used for validation: a parent is
    typically a meter or an electrical panel that legitimately sits in a
    technical room, so comparing its area to its children's areas is unsound.
    """
    issues: list[dict[str, Any]] = []

    for node in nodes.values():
        parent_id = node["parent_id"]
        if parent_id and parent_id not in nodes:
            issues.append(
                {
                    "severity": "error",
                    "kind": MISSING_PARENT,
                    "node": node["id"],
                    "message": f"Parent introuvable : {parent_id}",
                }
            )
        if parent_id == node["id"]:
            issues.append(
                {
                    "severity": "error",
                    "kind": SELF_PARENT,
                    "node": node["id"],
                    "message": "Un appareil ne peut pas être son propre parent.",
                }
            )

    issues.extend(_detect_cycles(nodes))
    return issues


def _children_map(nodes: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    """Map each node id to the list of its child ids."""
    children: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for node in nodes.values():
        parent_id = node["parent_id"]
        if parent_id and parent_id in nodes:
            children[parent_id].append(node["id"])
    return children


def _depth(nodes: dict[str, dict[str, Any]], node_id: str) -> int:
    """Distance from the root (root = 1). Cycle-safe."""
    tier = 1
    seen: set[str] = set()
    current = nodes[node_id]["parent_id"]
    while current and current in nodes and current not in seen:
        seen.add(current)
        tier += 1
        current = nodes[current]["parent_id"]
    return tier


def annotate(
    nodes: dict[str, dict[str, Any]],
    locations: dict[str, dict[str, Any]] | None = None,
    panel_ids: set[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Annotate each node in place.

    Adds:
    - ``has_children``: another node is included in this one.
    - ``manual_panel``: this node is manually marked as a panel/zone.
    - ``is_panel``: ``has_children or manual_panel`` (a meter / electrical panel).
    - ``tier``: depth from the root (1 = primary panel), independent of children.
    - ``rooms``: distinct area names of the node's direct *appliance* children
      (leaves that are not themselves panels). Child panels are sub-zones and are
      not folded in here. Requires ``locations``.
    """
    panel_ids = panel_ids or set()
    children = _children_map(nodes)

    def _is_panel(node_id: str) -> bool:
        return bool(children[node_id]) or node_id in panel_ids

    for node_id, node in nodes.items():
        node["has_children"] = bool(children[node_id])
        node["manual_panel"] = node_id in panel_ids
        node["is_panel"] = _is_panel(node_id)
        node["tier"] = _depth(nodes, node_id)
        rooms: list[str] = []
        if locations:
            for child_id in children[node_id]:
                if _is_panel(child_id):
                    continue  # child is a panel / sub-zone, not an appliance
                area_name = (locations.get(child_id) or {}).get("area_name")
                if area_name and area_name not in rooms:
                    rooms.append(area_name)
        node["rooms"] = sorted(rooms)
    return nodes


def _detect_cycles(nodes: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Detect cycles by following single parent pointers (white/grey/black DFS)."""
    white, grey, black = 0, 1, 2
    color = {node_id: white for node_id in nodes}
    stack: list[str] = []
    issues: list[dict[str, Any]] = []

    def visit(node_id: str) -> None:
        color[node_id] = grey
        stack.append(node_id)
        parent = nodes[node_id]["parent_id"]
        if parent and parent in nodes:
            if color[parent] == grey:
                start = stack.index(parent)
                chain = stack[start:] + [parent]
                issues.append(
                    {
                        "severity": "error",
                        "kind": CYCLE,
                        "node": node_id,
                        "message": "Cycle détecté : " + " → ".join(chain),
                    }
                )
            elif color[parent] == white:
                visit(parent)
        stack.pop()
        color[node_id] = black

    for node_id in nodes:
        if color[node_id] == white:
            visit(node_id)
    return issues
