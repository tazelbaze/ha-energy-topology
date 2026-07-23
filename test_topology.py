"""Tests for the real topology logic shipped in the integration.

These exercise custom_components/energy_topology/topology.py directly (made
importable by conftest.py), not a parallel reimplementation.
"""
from topology import (
    CROSS_AREA,
    CROSS_FLOOR,
    CYCLE,
    MISSING_PARENT,
    SELF_PARENT,
    build_nodes,
    validate,
)


def kinds(items, locations=None):
    return {issue["kind"] for issue in validate(build_nodes(items), locations)}


def test_valid_tree_has_no_issues():
    items = [
        {"stat_consumption": "sensor.house"},
        {"stat_consumption": "sensor.kitchen", "included_in_stat": "sensor.house"},
        {"stat_consumption": "sensor.fridge", "included_in_stat": "sensor.kitchen"},
    ]
    assert validate(build_nodes(items)) == []


def test_missing_parent():
    items = [{"stat_consumption": "sensor.fridge", "included_in_stat": "sensor.x"}]
    assert MISSING_PARENT in kinds(items)


def test_self_parent():
    items = [{"stat_consumption": "sensor.a", "included_in_stat": "sensor.a"}]
    assert SELF_PARENT in kinds(items)


def test_cycle():
    items = [
        {"stat_consumption": "sensor.a", "included_in_stat": "sensor.b"},
        {"stat_consumption": "sensor.b", "included_in_stat": "sensor.a"},
    ]
    assert CYCLE in kinds(items)


def test_build_nodes_skips_entries_without_id():
    nodes = build_nodes([{"name": "no id"}, {"stat_consumption": "sensor.a"}])
    assert set(nodes) == {"sensor.a"}


def test_cross_floor_detected_and_takes_precedence_over_area():
    items = [
        {"stat_consumption": "sensor.panel"},
        {"stat_consumption": "sensor.dev", "included_in_stat": "sensor.panel"},
    ]
    locations = {
        "sensor.panel": {
            "area_id": "annexe",
            "area_name": "Annexe",
            "floor_id": "etage",
            "floor_name": "Etage",
        },
        "sensor.dev": {
            "area_id": "cuisine",
            "area_name": "Cuisine",
            "floor_id": "rez_de_chaussee",
            "floor_name": "Rez-de-Chaussée",
        },
    }
    result = kinds(items, locations)
    assert CROSS_FLOOR in result
    assert CROSS_AREA not in result


def test_cross_area_same_floor():
    items = [
        {"stat_consumption": "sensor.panel"},
        {"stat_consumption": "sensor.dev", "included_in_stat": "sensor.panel"},
    ]
    locations = {
        "sensor.panel": {"area_id": "salon", "area_name": "Salon",
                         "floor_id": "rdc", "floor_name": "RDC"},
        "sensor.dev": {"area_id": "cuisine", "area_name": "Cuisine",
                       "floor_id": "rdc", "floor_name": "RDC"},
    }
    result = kinds(items, locations)
    assert CROSS_AREA in result
    assert CROSS_FLOOR not in result


def test_no_cross_boundary_when_location_unknown():
    items = [
        {"stat_consumption": "sensor.panel"},
        {"stat_consumption": "sensor.dev", "included_in_stat": "sensor.panel"},
    ]
    locations = {
        "sensor.panel": {"area_id": None, "floor_id": None},
        "sensor.dev": {"area_id": "cuisine", "floor_id": "rdc"},
    }
    assert kinds(items, locations) == set()
