"""Backend FastAPI routes of the client-bridge plugin (/api/plugins/client-bridge/*).

Mounted automatically (including via _try_hot_mount_plugin_api without restarting
hermes-dashboard.service) once 'client-bridge' is in plugins.enabled.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import socket
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _load_store():
    spec = importlib.util.spec_from_file_location("client_bridge_store", PLUGIN_DIR / "store.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


store = _load_store()
router = APIRouter()


@router.get("/ping")
async def ping():
    return {
        "ok": True,
        "plugin": "client-bridge",
        "version": "2.0.0",
        "server_host": socket.gethostname(),
        "desktop_plugin_sha": store.desktop_plugin_sha(),
        "time": time.time(),
    }


@router.post("/register")
async def register_client_route(request: Request):
    try:
        body = await request.json()
        if isinstance(body, str):
            body = json.loads(body)
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    remote_ip = request.client.host if request.client else ""
    record = store.register_client(body, remote_ip=remote_ip)
    pending = store.pending_requests_for(record["client_id"], remote_ip=remote_ip)
    return {
        "ok": True,
        "client": record,
        "pending_requests": pending,
        "desktop_plugin_sha": store.desktop_plugin_sha(),
    }


@router.get("/poll")
async def poll_requests(
    client_id: str,
    request: Request,
    active_session_id: str = "",
    focused_session_id: str = "",
    mode: str = "",
    wait: float = 0.0,
):
    remote_ip = request.client.host if request.client else ""
    store.touch_client(
        client_id=client_id,
        remote_ip=remote_ip,
        active_session_id=active_session_id,
        focused_session_id=focused_session_id,
        mode=mode,
    )
    pending = store.pending_requests_for(client_id, remote_ip=remote_ip)
    hold = min(max(0.0, float(wait or 0.0)), 25.0)
    if not pending and hold > 0.0:
        deadline = time.monotonic() + hold
        while time.monotonic() < deadline:
            if await request.is_disconnected():
                break
            await asyncio.sleep(0.04)
            pending = store.pending_requests_for(client_id, remote_ip=remote_ip)
            if pending:
                break
    return {
        "ok": True,
        "long_poll": hold > 0.0,
        "pending_requests": pending,
        "desktop_plugin_sha": store.desktop_plugin_sha(),
    }


@router.post("/respond")
async def respond_route(request: Request):
    try:
        body: Any = await request.json()
        if isinstance(body, str):
            body = json.loads(body)
    except Exception as exc:
        raise HTTPException(400, f"Invalid JSON: {exc}")
    if not isinstance(body, dict) or not body.get("req_id"):
        raise HTTPException(400, "req_id is required")
    ok = store.record_response(body)
    return {"ok": ok}


@router.get("/clients")
async def get_clients():
    return {
        "ok": True,
        "desktop_plugin_sha": store.desktop_plugin_sha(),
        "clients": store.list_clients(include_offline=True),
    }


@router.get("/desktop-plugin.js", response_class=PlainTextResponse)
async def download_desktop_plugin():
    sha, source = store.desktop_plugin_bundle()
    if not source:
        raise HTTPException(404, "desktop/plugin.js not found")
    return PlainTextResponse(
        source,
        media_type="application/javascript",
        headers={"X-Plugin-Sha256": sha} if sha else {},
    )


@router.get("/desktop-plugin-bundle")
async def download_desktop_plugin_bundle():
    sha, source = store.desktop_plugin_bundle()
    if not source:
        raise HTTPException(404, "desktop/plugin.js not found")
    return {
        "ok": True,
        "sha": sha,
        "source": source,
    }
