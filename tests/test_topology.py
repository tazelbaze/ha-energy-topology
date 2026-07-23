"""Tests for the real topology logic shipped in the integration.

These exercise custom_components/energy_topology/topology.py directly (made
importable by conftest.py), not a parallel reimplementation.
"""
from topology import (
    CYCLE,
    MISSING_PARENT,
    QUANTITATIVE_MISMATCH,
    SELF_PARENT,
    annotate,
    build_nodes,
    check_quantities,
    sanitize_items,
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


def test_manual_flag_makes_childless_node_a_panel():
    nodes = build_nodes([
        {"stat_consumption": "sensor.main", "name": "Compteur"},
        {"stat_consumption": "sensor.etage", "name": "Etage",
         "included_in_stat": "sensor.main"},
        {"stat_consumption": "sensor.oven", "name": "Four",
         "included_in_stat": "sensor.main"},
    ])
    annotate(nodes, None, {"sensor.etage"})
    assert nodes["sensor.etage"]["is_panel"] is True
    assert nodes["sensor.etage"]["manual_panel"] is True
    assert nodes["sensor.etage"]["has_children"] is False
    assert nodes["sensor.etage"]["tier"] == 2  # secondaire under Compteur
    # A plain appliance stays a leaf.
    assert nodes["sensor.oven"]["is_panel"] is False


def test_manual_panel_excluded_from_parent_rooms():
    nodes = build_nodes([
        {"stat_consumption": "sensor.main"},
        {"stat_consumption": "sensor.etage", "included_in_stat": "sensor.main"},
        {"stat_consumption": "sensor.oven", "included_in_stat": "sensor.main"},
    ])
    locations = {
        "sensor.main": {"area_name": "Système"},
        "sensor.etage": {"area_name": "Système"},
        "sensor.oven": {"area_name": "Cuisine"},
    }
    annotate(nodes, locations, {"sensor.etage"})
    # etage is a panel now, so it must not be counted as a room of main.
    assert nodes["sensor.main"]["rooms"] == ["Cuisine"]


# --- sanitisation of a draft before writing -------------------------------

def test_sanitize_keeps_only_valid_keys():
    result = sanitize_items([
        {
            "stat_consumption": "sensor.a",
            "name": "A",
            "stat_rate": "sensor.a_power",
            "included_in_stat": "sensor.main",
            "is_panel": True,          # injected junk, must be dropped
            "children": ["x"],          # injected junk, must be dropped
        },
    ])
    assert result == [
        {
            "stat_consumption": "sensor.a",
            "stat_rate": "sensor.a_power",
            "name": "A",
            "included_in_stat": "sensor.main",
        }
    ]


def test_sanitize_drops_entries_without_id_and_empty_values():
    result = sanitize_items([
        {"name": "no id"},
        {"stat_consumption": "sensor.b", "included_in_stat": None, "name": ""},
    ])
    assert result == [{"stat_consumption": "sensor.b"}]


# --- quantitative validation ----------------------------------------------

def _panel_and_children():
    return build_nodes([
        {"stat_consumption": "sensor.panel"},
        {"stat_consumption": "sensor.a", "included_in_stat": "sensor.panel"},
        {"stat_consumption": "sensor.b", "included_in_stat": "sensor.panel"},
    ])


def test_quantities_flag_children_exceeding_parent():
    nodes = _panel_and_children()
    # Children sum 80, parent 50 -> mismatch.
    issues = check_quantities(nodes, {"sensor.panel": 50, "sensor.a": 50, "sensor.b": 30})
    assert any(i["kind"] == QUANTITATIVE_MISMATCH and i["node"] == "sensor.panel" for i in issues)


def test_quantities_ok_when_children_below_parent():
    nodes = _panel_and_children()
    issues = check_quantities(nodes, {"sensor.panel": 100, "sensor.a": 40, "sensor.b": 30})
    assert issues == []


def test_quantities_tolerance_absorbs_small_noise():
    nodes = _panel_and_children()
    # Children 101 vs parent 100 -> within 3% tolerance, no issue.
    issues = check_quantities(nodes, {"sensor.panel": 100, "sensor.a": 51, "sensor.b": 50})
    assert issues == []


def test_quantities_skips_nodes_without_measure():
    nodes = _panel_and_children()
    # No parent value -> skipped.
    assert check_quantities(nodes, {"sensor.a": 50, "sensor.b": 60}) == []
