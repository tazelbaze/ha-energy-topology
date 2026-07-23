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
) -> dict[str, dict[str, Any]]:
    """Annotate each node in place.

    Adds:
    - ``is_panel``: the node aggregates children (a meter / electrical panel).
    - ``tier``: depth from the root (1 = primary panel).
    - ``rooms``: distinct area names of the node's direct *leaf* children
      (the rooms this zone directly covers). Child panels are sub-zones and are
      not folded in here. Requires ``locations``.
    """
    children = _children_map(nodes)
    for node_id, node in nodes.items():
        kids = children[node_id]
        node["is_panel"] = bool(kids)
        node["tier"] = _depth(nodes, node_id)
        rooms: list[str] = []
        if locations:
            for child_id in kids:
                if children[child_id]:
                    continue  # child is itself a panel / sub-zone
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
