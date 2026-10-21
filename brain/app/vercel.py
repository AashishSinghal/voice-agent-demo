"""Vercel entrypoint: the ASGI app Vercel loads (see pyproject [tool.vercel]).

Nothing is started here. The database pool and connectors are built on the first
request (app/main.py get_runtime), because a serverless host may not run
FastAPI's startup hooks.
"""

from .main import create_app

app = create_app()
