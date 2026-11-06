"""Run the fake Notion on :9100 so the connect flow can be tried without a real app.

    uv run python scripts/fake_notion.py

Then point the brain at it:
    NOTION_AUTH_BASE=http://localhost:9100 NOTION_API_BASE=http://localhost:9100
    NOTION_CLIENT_ID=fake NOTION_CLIENT_SECRET=fake
"""

import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.fake_notion import build  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(build(), host="127.0.0.1", port=9100, log_level="warning")
