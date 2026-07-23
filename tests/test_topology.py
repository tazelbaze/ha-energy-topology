"""Reference tests for the topology rules.

These tests document the expected graph behaviour independently from Home Assistant.
"""

def validate(items):
    nodes = {item["stat_consumption"]: item.get("included_in_stat") for item in items}
    issues = []
    for node, parent in nodes.items():
        if parent and parent not in nodes:
            issues.append((node, "missing_parent"))
        if parent == node:
            issues.append((node, "self_parent"))
    for start in nodes:
        seen = set()
        current = start
        while current in nodes and nodes[current]:
            if current in seen:
                issues.append((start, "cycle"))
                break
            seen.add(current)
            current = nodes[current]
    return issues


def test_valid_tree():
    assert validate([
        {"stat_consumption": "sensor.house"},
        {"stat_consumption": "sensor.kitchen", "included_in_stat": "sensor.house"},
        {"stat_consumption": "sensor.fridge", "included_in_stat": "sensor.kitchen"},
    ]) == []


def test_missing_parent():
    assert ("sensor.fridge", "missing_parent") in validate([
        {"stat_consumption": "sensor.fridge", "included_in_stat": "sensor.unknown"}
    ])


def test_cycle():
    issues = validate([
        {"stat_consumption": "sensor.a", "included_in_stat": "sensor.b"},
        {"stat_consumption": "sensor.b", "included_in_stat": "sensor.a"},
    ])
    assert any(kind == "cycle" for _, kind in issues)
