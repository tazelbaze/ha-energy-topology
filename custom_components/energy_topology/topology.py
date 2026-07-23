"""Pure topology logic for Energy Topology.

This module has no Home Assistant imports so it can be unit-tested directly.
It builds the device forest from the Energy prefs ``device_consumption`` list
and validates it. Location-aware checks (cross-area / cross-floor) run only when
a location map is supplied by the caller.
"""
from __future__ import annotations

from typing import Any

# Issue kinds
MISSING_PARENT = "missing_parent"
SELF_PARENT = "self_parent"
CYCLE = "cycle"
CROSS_AREA = "cross_area"
CROSS_FLOOR = "cross_floor"


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


def validate(
    nodes: dict[str, dict[str, Any]],
    locations: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return the list of issues found in the topology.

    ``locations`` maps a node id to ``{area_id, area_name, floor_id, floor_name}``.
    When provided, cross-area and cross-floor attachments are reported as
    warnings. A link is reported at most once (floor mismatch takes precedence
    over area mismatch).
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

    if locations:
        issues.extend(_detect_cross_boundary(nodes, locations))

    return issues


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


def _detect_cross_boundary(
    nodes: dict[str, dict[str, Any]],
    locations: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Flag included_in_stat links that cross an area or a floor boundary."""
    issues: list[dict[str, Any]] = []
    for node in nodes.values():
        parent_id = node["parent_id"]
        if not parent_id or parent_id not in nodes:
            continue
        child = locations.get(node["id"]) or {}
        parent = locations.get(parent_id) or {}
        c_floor, p_floor = child.get("floor_id"), parent.get("floor_id")
        c_area, p_area = child.get("area_id"), parent.get("area_id")

        if c_floor and p_floor and c_floor != p_floor:
            issues.append(
                {
                    "severity": "warning",
                    "kind": CROSS_FLOOR,
                    "node": node["id"],
                    "message": (
                        "Rattachement inter-étages : "
                        f"{child.get('floor_name') or c_floor}"
                        f" → {parent.get('floor_name') or p_floor}"
                    ),
                }
            )
        elif c_area and p_area and c_area != p_area:
            issues.append(
                {
                    "severity": "warning",
                    "kind": CROSS_AREA,
                    "node": node["id"],
                    "message": (
                        "Rattachement inter-pièces : "
                        f"{child.get('area_name') or c_area}"
                        f" → {parent.get('area_name') or p_area}"
                    ),
                }
            )
    return issues
