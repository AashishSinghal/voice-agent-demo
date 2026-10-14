"""Terminal client for the brain: see every event a voice call would produce.

    uv run python scripts/chat.py                 # against localhost:8000
    uv run python scripts/chat.py --url http://host:8000 --session demo

Type a message to take a turn. Commands:
    /heard <spoken> | <unspoken>   pretend the caller interrupted after hearing
                                   only <spoken> (what the gateway reports)
    /history                       what the brain remembers, as the model sees it
    /quit
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import httpx

DIM, BOLD, GREEN, YELLOW, CYAN, RED, RESET = (
    "\033[2m", "\033[1m", "\033[32m", "\033[33m", "\033[36m", "\033[31m", "\033[0m"
)  # fmt: skip


def turn(client: httpx.Client, url: str, session: str, text: str) -> None:
    started = time.monotonic()
    first_token = None
    print(f"{BOLD}agent:{RESET} ", end="", flush=True)
    with client.stream("POST", f"{url}/v1/turn", json={"session_id": session, "text": text}) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            e = json.loads(line[5:])
            kind = e["type"]
            if kind == "token":
                if first_token is None:
                    first_token = time.monotonic() - started
                print(e["text"], end="", flush=True)
            elif kind == "context":
                rep = e["report"]
                used = " ".join(f"{k}={v}" for k, v in rep["used"].items() if v)
                dropped = f" {YELLOW}dropped {len(rep['dropped'])}{RESET}" if rep["dropped"] else ""
                print(f"\n{DIM}  context {rep['totalUsed']}/{rep['budget']} [{used}]{RESET}{dropped}")
            elif kind == "tool_call":
                print(f"{CYAN}  tool_call   {e['name']}({json.dumps(e['args'])}){RESET}")
            elif kind == "tool_result":
                print(f"{CYAN}  tool_result {e['name']} -> {e['content']}{RESET}")
                print(f"{BOLD}agent:{RESET} ", end="", flush=True)
            elif kind == "usage":
                step = (
                    f" {YELLOW}(stepped down from {e['degraded_from']}){RESET}" if e["degraded_from"] else ""
                )
                print(
                    f"\n{DIM}  usage {e['tier']}:{e['model']} "
                    f"{e['prompt_tokens']}in/{e['completion_tokens']}out ${e['usd']:.6f}{RESET}{step}"
                )
            elif kind == "done":
                ft = f"{first_token * 1000:.0f}ms" if first_token else "n/a"
                flag = f" {YELLOW}DEGRADED{RESET}" if e["degraded"] else ""
                print(
                    f"\n{GREEN}  done{RESET} steps={e['steps']} turn=${e['turn_usd']:.6f} "
                    f"first-token={ft} total={(time.monotonic() - started) * 1000:.0f}ms{flag}"
                )
            elif kind == "error":
                print(f"\n{RED}  error: {e['message']}{RESET}")


def history(client: httpx.Client, url: str, session: str) -> None:
    data = client.get(f"{url}/v1/threads/{session}").json()
    for m in data.get("history", []):
        who = {"human": "caller", "ai": "agent"}.get(m["role"], m["role"])
        cut = f" {YELLOW}[interrupted]{RESET}" if m["interrupted"] else ""
        print(f"  {who:7}{cut} {m['content'][:200]}")
        if m["unspoken"]:
            print(f"  {DIM}        never heard: {m['unspoken'][:200]}{RESET}")
    print(f"{DIM}  session spend ${data.get('sessionUsd', 0):.6f}{RESET}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--session", default=f"cli-{int(time.time())}")
    args = ap.parse_args()
    url = args.url.rstrip("/")

    with httpx.Client(timeout=None) as client:
        try:
            h = client.get(f"{url}/health", timeout=3).json()
        except httpx.HTTPError:
            print(f"{RED}No brain at {url}. Start it first (see brain/README.md).{RESET}")
            return 1
        print(f"{DIM}brain: provider={h['provider']} tiers={h['tiers']} budget=${h['turnBudgetUsd']}{RESET}")
        print(f"{DIM}session {args.session} - /history, /heard <spoken> | <unspoken>, /quit{RESET}\n")
        while True:
            try:
                text = input(f"{BOLD}you:{RESET} ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if not text:
                continue
            if text == "/quit":
                return 0
            if text == "/history":
                history(client, url, args.session)
            elif text.startswith("/heard"):
                spoken, _, unspoken = text.removeprefix("/heard").partition("|")
                r = client.post(
                    f"{url}/v1/threads/{args.session}/heard",
                    json={"spoken": spoken.strip(), "unspoken": unspoken.strip() or None},
                )
                print(f"{DIM}  {r.json()}{RESET}")
            else:
                turn(client, url, args.session, text)
            print()


if __name__ == "__main__":
    sys.exit(main())
