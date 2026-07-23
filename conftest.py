"""Make the integration's pure-logic module importable in tests."""
import pathlib
import sys

sys.path.insert(
    0,
    str(pathlib.Path(__file__).parent / "custom_components" / "energy_topology"),
)
