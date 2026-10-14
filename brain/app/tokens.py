"""Token estimation.

A tokenizer would be exact, but the usual ones download vocabulary files at
runtime, which breaks offline tests and the no-network CI. This estimate errs
high on purpose: over-counting trims a little early, under-counting overflows
the window, and only one of those is a silent failure.
"""

from __future__ import annotations

import json
import math

from langchain_core.messages import BaseMessage

CHARS_PER_TOKEN = 3.5
PER_MESSAGE_OVERHEAD = 4


def count_text(text: str) -> int:
    if not text:
        return 0
    by_chars = len(text) / CHARS_PER_TOKEN
    by_words = len(text.split()) * 1.3
    return math.ceil(max(by_chars, by_words))


def count_message(message: BaseMessage) -> int:
    content = message.content if isinstance(message.content, str) else json.dumps(message.content)
    total = count_text(content) + PER_MESSAGE_OVERHEAD
    for call in getattr(message, "tool_calls", None) or []:
        total += count_text(call["name"]) + count_text(json.dumps(call["args"]))
    return total


def count_messages(messages: list[BaseMessage]) -> int:
    return sum(count_message(m) for m in messages)


def count_schema(schema: dict) -> int:
    return count_text(json.dumps(schema, separators=(",", ":")))
