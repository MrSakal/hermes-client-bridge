"""Agent half of the client-bridge plugin (v2.0).

Provides 5 orthogonal primitive tools to inspect and control the OS, filesystem,
warm/background terminals, text clipboard, and desktop plugins of whichever Hermes
Desktop client machine the user is connected from (deterministic multi-machine
session routing). Does not duplicate Hermes core media/preview/window tools.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from typing import Any

from . import store

PLUGIN_ID = "client-bridge"

TOOL_SCHEMAS = [
    {
        "name": "client_list_machines",
        "description": (
            "List all Hermes Desktop client machines registered with this server, including "
            "hostname, OS/platform, user, home_dir, desktop_plugins_root, installed desktop "
            "plugins, bridge mode (full/ask/readonly/off), battery state, active background PTYs, "
            "plugin sync status, IP, and online status."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "include_offline": {
                    "type": "boolean",
                    "default": True,
                    "description": "Include clients that have not sent a heartbeat recently.",
                }
            },
        },
    },
    {
        "name": "client_exec",
        "description": (
            "Execute commands or manage background PTY terminals on the connected Hermes Desktop "
            "client machine (PowerShell on Windows, bash/zsh on macOS/Linux — NOT on the Linux server). "
            "Uses a fast warm persistent shell by default, or manages long-running background PTYs "
            "(dev servers, watchers, builds) via background=true / action."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Command to execute (when action='run') or input text to send (when action='write').",
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional working directory on the client machine.",
                },
                "timeout": {
                    "type": "number",
                    "default": 30,
                    "description": "Timeout in seconds (default 30).",
                },
                "background": {
                    "type": "boolean",
                    "default": False,
                    "description": "Start command in a persistent background PTY on the client and return pty_id immediately.",
                },
                "action": {
                    "type": "string",
                    "enum": ["run", "list", "read", "write", "kill", "reset_shell"],
                    "default": "run",
                    "description": (
                        "'run' executes command; 'list' lists active client background PTYs; "
                        "'read'/'write'/'kill' inspect, send input to, or stop pty_id; "
                        "'reset_shell' recycles the warm persistent shell."
                    ),
                },
                "pty_id": {
                    "type": "string",
                    "description": "Background PTY id returned by background=true (used with action='read'|'write'|'kill').",
                },
                "fresh_shell": {
                    "type": "boolean",
                    "default": False,
                    "description": "Spawn a clean one-off PTY instead of reusing the warm persistent shell.",
                },
                "target_client": {
                    "type": "string",
                    "description": "Optional client hostname, client_id, or IP. Omit to target the active client.",
                },
            },
        },
    },
    {
        "name": "client_list_dir",
        "description": "List directory contents on the connected Hermes Desktop client machine.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path on the client machine (defaults to the client's home directory).",
                },
                "target_client": {
                    "type": "string",
                    "description": "Optional client hostname, client_id, or IP.",
                },
            },
        },
    },
    {
        "name": "client_read_file",
        "description": (
            "Read a UTF-8 text file or the system text clipboard (clipboard=true) directly "
            "from the connected Hermes Desktop client machine."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute file path on the client machine (omit when clipboard=true).",
                },
                "clipboard": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, read text from the client machine's system clipboard instead of a file.",
                },
                "target_client": {
                    "type": "string",
                    "description": "Optional client hostname, client_id, or IP.",
                },
            },
        },
    },
    {
        "name": "client_write_file",
        "description": (
            "Write a UTF-8 text file onto the connected Hermes Desktop client machine, "
            "or copy text onto the client's system clipboard (clipboard=true)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute file path on the client machine (omit when clipboard=true).",
                },
                "content": {
                    "type": "string",
                    "description": "Full text content to write to the file or clipboard.",
                },
                "clipboard": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, copy content to the client machine's system clipboard instead of writing a file.",
                },
                "target_client": {
                    "type": "string",
                    "description": "Optional client hostname, client_id, or IP.",
                },
            },
            "required": ["content"],
        },
    },
]


def _call_session_id(kwargs: dict[str, Any]) -> str:
    return str(
        kwargs.get("session_id")
        or os.environ.get("HERMES_SESSION_ID")
        or ""
    ).strip()


def client_list_machines(args: dict, **kwargs) -> str:
    include_offline = bool((args or {}).get("include_offline", True))
    sid = _call_session_id(kwargs)
    clients = store.list_clients(include_offline=include_offline)
    active = store.resolve_target_client(chat_session_id=sid)
    return json.dumps(
        {
            "ok": True,
            "active_client_id": active.get("client_id") if active else None,
            "desktop_plugin_sha": store.desktop_plugin_sha(),
            "clients": clients,
        },
        ensure_ascii=False,
    )


def client_exec(args: dict, **kwargs) -> str:
    args = args or {}
    action = str(args.get("action") or "run").strip().lower()
    timeout = float(args.get("timeout") or 30.0)
    sid = _call_session_id(kwargs)

    if action == "run" and not str(args.get("command") or "").strip():
        return json.dumps({"ok": False, "error": "command is required when action='run'"}, ensure_ascii=False)

    rpc_action = "exec" if action == "run" and not args.get("background") else "pty_manage"
    params = {
        "op": "start" if (action == "run" and args.get("background")) else action,
        "command": args.get("command", ""),
        "cwd": args.get("cwd"),
        "timeout_ms": int(timeout * 1000),
        "pty_id": args.get("pty_id"),
        "fresh_shell": bool(args.get("fresh_shell", False)),
    }
    res = store.dispatch_request(
        rpc_action,
        params,
        target_client=args.get("target_client"),
        timeout=timeout + 8.0,
        session_id=sid,
    )
    return json.dumps(res, ensure_ascii=False)


def client_list_dir(args: dict, **kwargs) -> str:
    args = args or {}
    sid = _call_session_id(kwargs)
    res = store.dispatch_request(
        "read_dir",
        {"path": args.get("path")},
        target_client=args.get("target_client"),
        timeout=20.0,
        session_id=sid,
    )
    return json.dumps(res, ensure_ascii=False)


def client_read_file(args: dict, **kwargs) -> str:
    args = args or {}
    sid = _call_session_id(kwargs)
    use_clipboard = bool(args.get("clipboard", False))
    path = str(args.get("path") or "").strip()
    if not use_clipboard and not path:
        return json.dumps({"ok": False, "error": "path is required unless clipboard=true"}, ensure_ascii=False)

    res = store.dispatch_request(
        "read_file",
        {"path": path, "clipboard": use_clipboard},
        target_client=args.get("target_client"),
        timeout=20.0,
        session_id=sid,
    )
    return json.dumps(res, ensure_ascii=False)


def client_write_file(args: dict, **kwargs) -> str:
    args = args or {}
    sid = _call_session_id(kwargs)
    use_clipboard = bool(args.get("clipboard", False))
    path = str(args.get("path") or "").strip()
    content = args.get("content", "")
    if not use_clipboard and not path:
        return json.dumps({"ok": False, "error": "path is required unless clipboard=true"}, ensure_ascii=False)

    res = store.dispatch_request(
        "write_file",
        {
            "path": path,
            "content": content if content is not None else "",
            "clipboard": use_clipboard,
        },
        target_client=args.get("target_client"),
        timeout=25.0,
        session_id=sid,
    )
    return json.dumps(res, ensure_ascii=False)


HANDLERS: dict[str, tuple[Any, str]] = {
    "client_list_machines": (client_list_machines, "🖥️"),
    "client_exec": (client_exec, "⚡"),
    "client_list_dir": (client_list_dir, "📂"),
    "client_read_file": (client_read_file, "📄"),
    "client_write_file": (client_write_file, "💾"),
}


def pre_llm_call(platform=None, session_id=None, **kwargs):
    if platform != "desktop":
        return None
    clients = store.list_clients(include_offline=False)
    if not clients:
        return None
    active = store.resolve_target_client(
        ui_session_id=os.environ.get("HERMES_UI_SESSION_ID"),
        chat_session_id=session_id,
    )
    lines = ["[Client Bridge — Connected Desktop Client Machines]"]
    if active:
        plugins_list = ", ".join(p.get("id", "?") for p in (active.get("installed_desktop_plugins") or [])) or "none"
        bat = ", battery=on" if active.get("on_battery") else ""
        ptys = active.get("active_ptys") or []
        pty_info = f", activePtys={len(ptys)}" if ptys else ""
        lines.append(
            f"Current user is writing from client: {active.get('hostname')} "
            f"(id={active.get('client_id')}, OS={active.get('platform')}/{active.get('arch')}, "
            f"user={active.get('user')}, IP={active.get('remote_ip')}, mode={active.get('mode')}{bat}{pty_info}, "
            f"home={active.get('home_dir')}, desktopPluginsRoot={active.get('desktop_plugins_root')}, "
            f"installedDesktopPlugins=[{plugins_list}])."
        )
    if len(clients) > 1:
        others = [
            f"{c.get('hostname')} ({c.get('platform')}, ip={c.get('remote_ip')}, mode={c.get('mode')})"
            for c in clients
            if not active or c.get("client_id") != active.get("client_id")
        ]
        if others:
            lines.append("Other online Desktop clients: " + "; ".join(others))
    lines.append(
        "Tools available (via client-bridge): client_list_machines, client_exec (warm shell + background PTYs), "
        "client_list_dir, client_read_file (file + clipboard=true), client_write_file (file + clipboard=true)."
    )
    return {"context": "\n".join(lines)}


def register(ctx):
    importlib.reload(store)
    for schema in TOOL_SCHEMAS:
        handler, emoji = HANDLERS[schema["name"]]
        ctx.register_tool(
            name=schema["name"],
            toolset=PLUGIN_ID,
            schema=schema,
            handler=handler,
            emoji=emoji,
        )
    ctx.register_hook("pre_llm_call", pre_llm_call)
