"""Spoken approval: yes, no, or something else.

Like backchannel classification in the gateway, this is a set lookup and not a
model call. It decides whether a destructive action runs, so it must be
predictable: only an unambiguous yes approves. Anything else, including a
hesitant "uh, maybe", declines.
"""

from __future__ import annotations

import re
from typing import Literal

Verdict = Literal["yes", "no", "other"]

YES = {
    "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it", "please do",
    "confirm", "confirmed", "correct", "that's right", "thats right", "go for it",
    "absolutely", "definitely", "yes please", "yes do it", "yes go ahead", "sure go ahead",
}  # fmt: skip
NO = {
    "no", "nope", "nah", "don't", "dont", "do not", "cancel", "stop", "never mind",
    "nevermind", "no thanks", "no thank you", "don't do it", "dont do it", "not now",
    "no don't", "no dont", "no cancel", "wait", "hold on",
}  # fmt: skip


def normalise(text: str) -> str:
    text = text.lower().replace("’", "'")
    text = re.sub(r"[^a-z0-9' ]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def classify(text: str) -> Verdict:
    t = normalise(text)
    # A negation anywhere wins over a yes: "yes... no wait" must not approve.
    words = set(t.split())
    if t in NO or ({"no", "nope", "don't", "dont", "cancel", "stop", "wait"} & words):
        return "no"
    if t in YES:
        return "yes"
    return "other"
