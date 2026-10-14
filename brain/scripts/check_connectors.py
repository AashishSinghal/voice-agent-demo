"""Start every connector in mcp.json and report what the model would see.

    uv run python scripts/check_connectors.py [path/to/mcp.json]

For each connector: did it start, which tools survive its policy, the risk the
brain assigned each one, and how many context tokens the schemas cost. Run this
after editing mcp.json. It calls no tools and spends nothing.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from langchain_core.utils.function_calling import convert_to_openai_tool

from app.connectors import connect_all, environment, load_specs
from app.settings import Settings
from app.tokens import count_schema
from app.tools import ToolSet


async def main(path: Path) -> int:
    specs, failed = load_specs(path, environment())
    toolset = ToolSet(entries=[])
    statuses = [*failed, *await connect_all(specs, toolset)]
    window = Settings.from_env().context_window

    print(f"config: {path} ({'found' if path.exists() else 'missing, using the built-in default'})\n")
    for s in statuses:
        print(f"{'OK  ' if s.ok else 'FAIL'} {s.name}" + (f"  {s.error}" if s.error else ""))
    total = 0
    for entry in toolset.entries:
        tokens = count_schema(convert_to_openai_tool(entry.tool))
        total += tokens
        print(f"     {entry.risk:8} {tokens:5}t  {entry.name}")
    pct = 100 * total / window
    print(f"\n{len(toolset.entries)} tools, {total} schema tokens = {pct:.0f}% of the {window}-token window")
    if pct > 35:
        print("warning: tool schemas crowd out the conversation. Narrow the connector with policy.allow.")
    await toolset.close()
    return 0 if all(s.ok for s in statuses) else 1


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("mcp.json")
    sys.exit(asyncio.run(main(target)))
