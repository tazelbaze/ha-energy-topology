"""Tests for the real topology logic shipped in the integration.

These exercise custom_components/energy_topology/topology.py directly (made
importable by conftest.py), not a parallel reimplementation.
"""
from topology import (
    CYCLE,
    MISSING_PARENT,
    SELF_PARENT,
    annotate,
    build_nodes,
    validate,
)


def kinds(items):
    return {issue["kind"] for issue in validate(build_nodes(items))}


# --- structural validation -------------------------------------------------

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


def test_location_is_not_used_for_validation():
    # A leaf in a different room from its meter-parent must NOT be an issue.
    items = [
        {"stat_consumption": "sensor.meter"},
        {"stat_consumption": "sensor.oven", "included_in_stat": "sensor.meter"},
    ]
    assert validate(build_nodes(items)) == []


def test_build_nodes_skips_entries_without_id():
    nodes = build_nodes([{"name": "no id"}, {"stat_consumption": "sensor.a"}])
    assert set(nodes) == {"sensor.a"}


# --- panel / tier / rooms annotation --------------------------------------

def _sample():
    return build_nodes([
        {"stat_consumption": "sensor.main", "name": "Compteur"},
        {"stat_consumption": "sensor.annexe", "name": "Annexe",
         "included_in_stat": "sensor.main"},
        {"stat_consumption": "sensor.pool", "name": "Bloc Piscine",
         "included_in_stat": "sensor.annexe"},
        {"stat_consumption": "sensor.pump", "name": "Filtration",
         "included_in_stat": "sensor.pool"},
        {"stat_consumption": "sensor.oven", "name": "Four",
         "included_in_stat": "sensor.main"},
    ])


def test_is_panel_and_tier():
    nodes = annotate(_sample())
    assert nodes["sensor.main"]["is_panel"] is True
    assert nodes["sensor.main"]["tier"] == 1
    assert nodes["sensor.annexe"]["tier"] == 2
    assert nodes["sensor.pool"]["tier"] == 3
    # Leaves are not panels.
    assert nodes["sensor.oven"]["is_panel"] is False
    assert nodes["sensor.pump"]["is_panel"] is False


def test_rooms_are_direct_leaf_children_only():
    locations = {
        "sensor.main": {"area_name": "Système"},
        "sensor.annexe": {"area_name": "Annexe"},
        "sensor.pool": {"area_name": "Local Piscine"},
        "sensor.pump": {"area_name": "Local Piscine"},
        "sensor.oven": {"area_name": "Cuisine"},
    }
    nodes = annotate(_sample(), locations)
    # main's direct leaf child is the oven (Cuisine); annexe/pool are sub-panels.
    assert nodes["sensor.main"]["rooms"] == ["Cuisine"]
    # pool's direct leaf child is the pump (Local Piscine).
    assert nodes["sensor.pool"]["rooms"] == ["Local Piscine"]
    # annexe has no direct leaf child (only the pool sub-panel).
    assert nodes["sensor.annexe"]["rooms"] == []
