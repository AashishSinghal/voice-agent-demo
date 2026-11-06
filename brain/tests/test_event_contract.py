"""The event shapes the gateway parses are these, in docs/contract/events.json.

The gateway's own test (backend/src/smoke.ts) runs the same file through its
parser, so a renamed field or a new event fails on whichever side drifted.
"""

import json
import typing
from pathlib import Path

from pydantic import TypeAdapter

from app.contract import Event

FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "docs" / "contract" / "events.json").read_text())
ADAPTER = TypeAdapter(Event)


def test_every_fixture_is_exactly_what_the_brain_emits():
    for case in FIXTURES:
        assert ADAPTER.validate_python(case["wire"]).model_dump() == case["wire"], case["wire"]["type"]


def test_every_event_type_the_brain_can_emit_has_a_fixture():
    union = typing.get_args(typing.get_args(Event)[0])
    declared = {typing.get_args(m.model_fields["type"].annotation)[0] for m in union}
    assert declared == {c["wire"]["type"] for c in FIXTURES}
