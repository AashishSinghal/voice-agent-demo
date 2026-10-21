"""Chat model factory, plus a deterministic fake for tests and CI.

The fake is not a mock of a library; it is a real BaseChatModel that replays a
script. That lets the whole graph, including tool loops and streaming, run
with no network and no key, which is what makes the trajectory gate (a later
phase) free to run on every pull request.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from .cost import Tier


class ScriptedChatModel(BaseChatModel):
    """Replays AIMessages in order. `loop=True` repeats the last one forever,
    which is how a runaway tool loop is simulated."""

    script: list[AIMessage]
    loop: bool = False
    cursor: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedChatModel:
        return self

    def _next(self) -> AIMessage:
        if not self.script:
            return AIMessage(content="ok")
        if self.cursor < len(self.script):
            msg = self.script[self.cursor]
            self.cursor += 1
            return msg
        return self.script[-1] if self.loop else AIMessage(content="ok")

    def _usage(self, messages: list[BaseMessage], out: AIMessage) -> dict:
        from .tokens import count_messages, count_text

        i = count_messages(messages)
        o = count_text(out.content if isinstance(out.content, str) else "") + 8
        return {"input_tokens": i, "output_tokens": o, "total_tokens": i + o}

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        msg = self._next()
        msg = msg.model_copy(update={"usage_metadata": self._usage(messages, msg)})
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        msg = self._next()
        text = msg.content if isinstance(msg.content, str) else ""
        words = text.split(" ")
        for i, word in enumerate(words):
            piece = word if i == 0 else " " + word
            chunk = ChatGenerationChunk(message=AIMessageChunk(content=piece))
            if run_manager:
                run_manager.on_llm_new_token(piece, chunk=chunk)
            yield chunk
        tail = AIMessageChunk(
            content="",
            tool_call_chunks=[
                {"name": c["name"], "args": __import__("json").dumps(c["args"]), "id": c["id"], "index": n}
                for n, c in enumerate(msg.tool_calls)
            ],
            usage_metadata=self._usage(messages, msg),
        )
        yield ChatGenerationChunk(message=tail)


def build_model(tier: Tier, fake: BaseChatModel | None = None) -> BaseChatModel:
    if tier.provider == "fake":
        return fake or ScriptedChatModel(script=[AIMessage(content="Hello from the fake model.")])
    if tier.provider == "groq":
        from langchain_groq import ChatGroq

        # gpt-oss thinks before it speaks, and the thinking counts against
        # max_tokens: at default effort a long-form prompt spent 218 of 220
        # tokens reasoning and returned no text. "low" cut that to about ten.
        effort = os.environ.get("GROQ_REASONING_EFFORT", "low").lower()
        extra = {"reasoning_effort": effort} if effort != "none" and "gpt-oss" in tier.model else {}
        return ChatGroq(model=tier.model, temperature=0.7, max_tokens=220, streaming=True, **extra)
    if tier.provider == "ollama":
        from langchain_ollama import ChatOllama

        return ChatOllama(model=tier.model, temperature=0.7, num_predict=220)
    raise ValueError(f"unknown provider {tier.provider!r}")
