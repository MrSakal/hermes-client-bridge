"""Shared state and RPC queue for the client-bridge plugin (v2.0).

Stores connected Desktop client registrations and pending/completed RPC requests
under plugin_data_dir('client-bridge') with flock file locking, throttled disk
writes, ghost-record pruning, in-process Condition wakeups via
``sys._client_bridge_runtime``, and zero-latency event push via
``broadcast_plugin_event``.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

PLUGIN_ID = "client-bridge"
ONLINE_TTL_SECONDS = 90.0
DISK_TOUCH_INTERVAL_SEC = 25.0
GHOST_CLIENT_TTL_SEC = 60.0
DEAD_CLIENT_TTL_SEC = 30 * 86400.0
STALE_REQ_TTL_SEC = 180.0


def _get_runtime() -> dict[str, Any]:
    rt = getattr(sys, "_client_bridge_runtime", None)
    if not isinstance(rt, dict):
        rt = {
            "cond": threading.Condition(),
            "mem_seen": {},          # client_id -> (last_seen_ts, remote_ip)
            "disk_written_at": {},   # client_id -> last_disk_write_ts
            "plugin_cache": None,    # (mtime_ns, sha256_16, source_text)
            "last_housekeeping": 0.0,
        }
        setattr(sys, "_client_bridge_runtime", rt)
    return rt


def data_root() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir
        root = Path(plugin_data_dir(PLUGIN_ID))
    except Exception:
        root = Path.home() / ".hermes" / "plugin-data" / PLUGIN_ID
    root.mkdir(parents=True, exist_ok=True)
    (root / "requests").mkdir(parents=True, exist_ok=True)
    (root / "responses").mkdir(parents=True, exist_ok=True)
    return root


def _clients_file() -> Path:
    return data_root() / "clients.json"


def _clients_lock_file() -> Path:
    return data_root() / "clients.lock"


@contextmanager
def _locked_clients_file():
    lock_path = _clients_lock_file()
    with open(lock_path, "a+", encoding="utf-8") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


def _read_clients_unlocked() -> dict[str, dict[str, Any]]:
    path = _clients_file()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_clients_unlocked(clients: dict[str, dict[str, Any]]) -> None:
    path = _clients_file()
    tmp = path.parent / f".clients.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp"
    try:
        tmp.write_text(json.dumps(clients, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _is_ghost_record(rec: dict[str, Any], now: float) -> bool:
    last_seen = float(rec.get("last_seen") or 0.0)
    age = max(0.0, now - last_seen)
    platform_name = str(rec.get("platform") or "").strip().lower()
    hostname = str(rec.get("hostname") or "").strip()
    has_identity = bool(rec.get("home_dir") or rec.get("user"))
    if (platform_name in ("", "unknown") or (not has_identity and hostname == rec.get("remote_ip"))) and age > GHOST_CLIENT_TTL_SEC:
        return True
    if last_seen > 0 and age > DEAD_CLIENT_TTL_SEC:
        return True
    return False


def desktop_plugin_bundle() -> tuple[str, str]:
    """Return (sha256_16, js_source) of desktop/plugin.js, cached by mtime_ns."""
    path = Path(__file__).resolve().parent / "desktop" / "plugin.js"
    if not path.is_file():
        return ("", "")
    rt = _get_runtime()
    try:
        st = path.stat()
        cached = rt.get("plugin_cache")
        if cached and cached[0] == st.st_mtime_ns:
            return (cached[1], cached[2])
        source = path.read_text(encoding="utf-8")
        sha = hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]
        rt["plugin_cache"] = (st.st_mtime_ns, sha, source)
        return (sha, source)
    except Exception as exc:
        logger.warning("client-bridge: failed to hash desktop/plugin.js: %s", exc)
        return ("", "")


def desktop_plugin_sha() -> str:
    return desktop_plugin_bundle()[0]


def maybe_housekeep(now: Optional[float] = None) -> None:
    now = now or time.time()
    rt = _get_runtime()
    if (now - float(rt.get("last_housekeeping") or 0.0)) < 60.0:
        return
    rt["last_housekeeping"] = now
    root = data_root()
    for sub in ("requests", "responses"):
        folder = root / sub
        try:
            for f in folder.iterdir():
                try:
                    if (now - f.stat().st_mtime) > STALE_REQ_TTL_SEC:
                        f.unlink(missing_ok=True)
                except OSError:
                    pass
        except OSError:
            pass


def load_clients() -> dict[str, dict[str, Any]]:
    with _locked_clients_file():
        return _read_clients_unlocked()


def save_clients(clients: dict[str, dict[str, Any]]) -> None:
    now = time.time()
    cleaned = {
        cid: rec for cid, rec in clients.items()
        if isinstance(rec, dict) and not _is_ghost_record(rec, now)
    }
    with _locked_clients_file():
        _write_clients_unlocked(cleaned)


def register_client(payload: dict[str, Any], remote_ip: str = "") -> dict[str, Any]:
    now = time.time()
    client_id = str(payload.get("client_id") or "").strip()
    hostname = str(payload.get("hostname") or "").strip()
    user = str(payload.get("user") or payload.get("username") or "").strip()
    platform_name = str(payload.get("platform") or "").strip()
    if not client_id:
        base = hostname or remote_ip or "desktop-client"
        client_id = f"{base}-{platform_name or 'os'}".lower().replace(" ", "-")

    rt = _get_runtime()
    with _locked_clients_file():
        clients = {
            cid: r for cid, r in _read_clients_unlocked().items()
            if isinstance(r, dict) and not _is_ghost_record(r, now)
        }
        existing = clients.get(client_id, {})

        ui_sessions: list[str] = []
        incoming_list = payload.get("ui_session_ids")
        if isinstance(incoming_list, list):
            for s in incoming_list:
                sv = str(s or "").strip()
                if sv and sv not in ui_sessions:
                    ui_sessions.append(sv)
        for prev_s in (existing.get("ui_session_ids") or []):
            sv = str(prev_s or "").strip()
            if sv and sv not in ui_sessions:
                ui_sessions.append(sv)
        for extra in (
            payload.get("ui_session_id"),
            payload.get("focused_session_id"),
            payload.get("focused_stored_session_id"),
            payload.get("active_chat_session_id"),
        ):
            sv = str(extra or "").strip()
            if sv:
                ui_sessions = [sv] + [s for s in ui_sessions if s != sv]
        ui_sessions = ui_sessions[:16]

        active_sid = str(
            payload.get("active_chat_session_id")
            if "active_chat_session_id" in payload
            else existing.get("active_chat_session_id", "")
        ).strip()
        focused_sid = str(
            payload.get("focused_session_id")
            if "focused_session_id" in payload
            else existing.get("focused_session_id", "")
        ).strip()
        focused_stored_sid = str(
            payload.get("focused_stored_session_id")
            if "focused_stored_session_id" in payload
            else existing.get("focused_stored_session_id", "")
        ).strip()

        record = {
            "client_id": client_id,
            "hostname": hostname or existing.get("hostname") or remote_ip or "unknown-host",
            "platform": platform_name or existing.get("platform") or "unknown",
            "os_version": str(payload.get("os_version") or existing.get("os_version") or ""),
            "arch": str(payload.get("arch") or existing.get("arch") or ""),
            "user": user or existing.get("user") or "",
            "home_dir": str(payload.get("home_dir") or existing.get("home_dir") or ""),
            "desktop_plugins_root": str(
                payload.get("desktop_plugins_root") or existing.get("desktop_plugins_root") or ""
            ),
            "installed_desktop_plugins": payload.get(
                "installed_desktop_plugins", existing.get("installed_desktop_plugins", [])
            ),
            "mode": str(payload.get("mode") or existing.get("mode") or "full"),
            "ui_session_ids": ui_sessions,
            "active_chat_session_id": active_sid,
            "focused_session_id": focused_sid,
            "focused_stored_session_id": focused_stored_sid,
            "on_battery": bool(payload.get("on_battery")) if "on_battery" in payload else bool(existing.get("on_battery", False)),
            "plugin_sha": str(payload.get("plugin_sha") or existing.get("plugin_sha") or ""),
            "active_ptys": payload.get("active_ptys") if isinstance(payload.get("active_ptys"), list) else existing.get("active_ptys", []),
            "remote_ip": remote_ip or existing.get("remote_ip") or "",
            "machine_profile": payload.get("machine_profile") or existing.get("machine_profile") or {},
            "last_seen": now,
        }
        clients[client_id] = record
        _write_clients_unlocked(clients)

    rt["mem_seen"][client_id] = (now, record["remote_ip"])
    rt["disk_written_at"][client_id] = now
    maybe_housekeep(now)
    return record


def touch_client(
    client_id: str,
    remote_ip: str = "",
    active_session_id: str = "",
    focused_session_id: str = "",
    mode: str = "",
) -> None:
    """Update client heartbeat in memory immediately and flush to disk at most every 25s
    (or immediately when IP, active session, or bridge mode changed)."""
    if not client_id:
        return
    now = time.time()
    rt = _get_runtime()
    prev_mem = rt["mem_seen"].get(client_id)
    rt["mem_seen"][client_id] = (now, remote_ip or (prev_mem[1] if prev_mem else ""))

    last_disk = float(rt["disk_written_at"].get(client_id) or 0.0)
    ip_changed = bool(remote_ip and prev_mem and prev_mem[1] and prev_mem[1] != remote_ip)
    meta_hint = bool(active_session_id or focused_session_id or mode)

    if (now - last_disk) < DISK_TOUCH_INTERVAL_SEC and not ip_changed and not meta_hint:
        return

    with _locked_clients_file():
        clients = _read_clients_unlocked()
        rec = clients.get(client_id)
        if not isinstance(rec, dict):
            return
        meta_changed = (
            (active_session_id and rec.get("active_chat_session_id") != active_session_id)
            or (focused_session_id and rec.get("focused_session_id") != focused_session_id)
            or (mode and rec.get("mode") != mode)
        )
        if (now - last_disk) < DISK_TOUCH_INTERVAL_SEC and not ip_changed and not meta_changed:
            return
        rec["last_seen"] = now
        if remote_ip:
            rec["remote_ip"] = remote_ip
        if mode:
            rec["mode"] = mode
        if active_session_id:
            rec["active_chat_session_id"] = active_session_id
            ui_sids = list(rec.get("ui_session_ids") or [])
            if active_session_id not in ui_sids:
                rec["ui_session_ids"] = [active_session_id] + ui_sids[:15]
        if focused_session_id:
            rec["focused_session_id"] = focused_session_id
            ui_sids = list(rec.get("ui_session_ids") or [])
            if focused_session_id not in ui_sids:
                rec["ui_session_ids"] = [focused_session_id] + ui_sids[:15]

        cleaned = {
            cid: r for cid, r in clients.items()
            if isinstance(r, dict) and not _is_ghost_record(r, now)
        }
        cleaned[client_id] = rec
        _write_clients_unlocked(cleaned)
        rt["disk_written_at"][client_id] = now


def list_clients(include_offline: bool = True) -> list[dict[str, Any]]:
    now = time.time()
    rt = _get_runtime()
    mem_seen = rt["mem_seen"]
    server_sha = desktop_plugin_sha()
    raw_clients = load_clients()
    out: list[dict[str, Any]] = []
    found_ghost = False

    for cid, rec in raw_clients.items():
        if not isinstance(rec, dict):
            continue
        if _is_ghost_record(rec, now):
            found_ghost = True
            continue
        item = dict(rec)
        last_seen = float(item.get("last_seen") or 0.0)
        mem = mem_seen.get(cid)
        if mem and mem[0] > last_seen:
            last_seen = mem[0]
            item["last_seen"] = last_seen
            if mem[1]:
                item["remote_ip"] = mem[1]
        age = max(0.0, now - last_seen)
        online = age <= ONLINE_TTL_SECONDS
        if not include_offline and not online:
            continue
        item["online"] = online
        item["last_seen_seconds_ago"] = round(age, 1)
        if server_sha:
            item["plugin_up_to_date"] = (item.get("plugin_sha") == server_sha)
        out.append(item)

    if found_ghost:
        try:
            save_clients(raw_clients)
        except Exception:
            pass

    out.sort(key=lambda r: (not r.get("online", False), -float(r.get("last_seen") or 0.0)))
    return out


def resolve_target_client(
    target_client: Optional[str] = None,
    ui_session_id: Optional[str] = None,
    chat_session_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    clients = list_clients(include_offline=True)
    if not clients:
        return None

    target = str(target_client or "").strip().lower()
    if target:
        pool_groups = ([c for c in clients if c.get("online")], clients)
        for pool in pool_groups:
            exact = [
                c for c in pool
                if target in (
                    str(c.get("client_id", "")).lower(),
                    str(c.get("hostname", "")).lower(),
                    str(c.get("user", "")).lower(),
                    str(c.get("remote_ip", "")).lower(),
                )
            ]
            if len(exact) == 1:
                return exact[0]
            partial = exact or [
                c for c in pool
                if target in str(c.get("client_id", "")).lower()
                or target in str(c.get("hostname", "")).lower()
            ]
            if len(partial) == 1:
                return partial[0]
        return None

    online = [c for c in clients if c.get("online") and c.get("mode") != "off"] or [c for c in clients if c.get("online")]
    search_pool = online or clients

    chat_sid = str(chat_session_id or os.environ.get("HERMES_SESSION_ID") or "").strip()
    ui_sid = str(ui_session_id or os.environ.get("HERMES_UI_SESSION_ID") or "").strip()

    for sid in (chat_sid, ui_sid):
        if sid:
            for c in search_pool:
                if c.get("focused_session_id") == sid:
                    return c

    for sid in (chat_sid, ui_sid):
        if sid:
            for c in search_pool:
                if sid in (c.get("active_chat_session_id"), c.get("focused_stored_session_id")):
                    return c

    for sid in (ui_sid, chat_sid):
        if sid:
            for c in search_pool:
                if sid in (c.get("ui_session_ids") or []):
                    return c

    return search_pool[0]


def pending_requests_for(client_id: str, remote_ip: str = "") -> list[dict[str, Any]]:
    req_dir = data_root() / "requests"
    resp_dir = data_root() / "responses"
    now = time.time()
    out = []
    for f in sorted(req_dir.glob("*.json")):
        try:
            req = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        rid = req.get("req_id")
        if not rid or (resp_dir / f"{rid}.json").exists():
            f.unlink(missing_ok=True)
            continue
        if now - float(req.get("created_at") or 0) > STALE_REQ_TTL_SEC:
            f.unlink(missing_ok=True)
            continue
        if req.get("target_client_id") == client_id:
            pushed_at = float(req.get("pushed_at") or 0.0)
            if pushed_at and (now - pushed_at) < 2.5 and not req.get("poll_delivered"):
                continue
            req["poll_delivered"] = True
            try:
                f.write_text(json.dumps(req, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
            out.append(req)
    return out


def record_response(payload: dict[str, Any]) -> bool:
    rid = str(payload.get("req_id") or "").strip()
    if not rid or "/" in rid or "\\" in rid or ".." in rid:
        return False
    resp_path = data_root() / "responses" / f"{rid}.json"
    req_path = data_root() / "requests" / f"{rid}.json"
    record = {
        "req_id": rid,
        "client_id": str(payload.get("client_id") or ""),
        "ok": bool(payload.get("ok")),
        "result": payload.get("result"),
        "error": payload.get("error"),
        "completed_at": time.time(),
    }
    tmp = resp_path.parent / f".{rid}.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    tmp.replace(resp_path)
    req_path.unlink(missing_ok=True)

    cond: threading.Condition = _get_runtime()["cond"]
    with cond:
        cond.notify_all()
    return True


def _push_event_to_desktop(req: dict[str, Any]) -> bool:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
        broadcast_plugin_event(PLUGIN_ID, "request", req)
        return True
    except Exception as exc:
        logger.debug("client-bridge broadcast fallback to poll: %s", exc)
        return False


def dispatch_request(
    action: str,
    params: dict[str, Any],
    target_client: Optional[str] = None,
    timeout: float = 30.0,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    client = resolve_target_client(target_client=target_client, chat_session_id=session_id)
    if client is None:
        if target_client:
            known = ", ".join(f"{c.get('hostname')} ({c.get('client_id')}, ip={c.get('remote_ip')})" for c in list_clients(True))
            return {
                "ok": False,
                "error": f"Target client '{target_client}' not found or ambiguous. Known clients: {known or 'none'}",
            }
        return {
            "ok": False,
            "error": (
                "No Hermes Desktop client is registered. Ensure desktop-plugins/client-bridge/plugin.js "
                "is installed and enabled on the Desktop client machine."
            ),
        }

    mode = str(client.get("mode") or "full").lower()
    if mode == "off":
        return {
            "ok": False,
            "client_id": client.get("client_id"),
            "hostname": client.get("hostname"),
            "error": f"Client Bridge is set to OFF on desktop '{client.get('hostname')}'.",
        }
    readonly_safe = ("client_info", "read_dir", "read_file")
    if mode == "readonly" and action not in readonly_safe:
        return {
            "ok": False,
            "client_id": client.get("client_id"),
            "hostname": client.get("hostname"),
            "error": (
                f"Client Bridge on '{client.get('hostname')}' is in READ-ONLY mode. "
                f"Switch to FULL or ASK mode in the Desktop status bar to allow '{action}'."
            ),
        }

    effective_timeout = max(1.0, float(timeout))
    if mode == "ask" and action not in readonly_safe:
        effective_timeout = max(effective_timeout, 90.0)

    rid = uuid.uuid4().hex[:16]
    now = time.time()
    req = {
        "req_id": rid,
        "target_client_id": client["client_id"],
        "target_remote_ip": client.get("remote_ip") or "",
        "action": action,
        "params": params or {},
        "created_at": now,
        "pushed_at": now,
    }
    req_path = data_root() / "requests" / f"{rid}.json"
    resp_path = data_root() / "responses" / f"{rid}.json"
    tmp_req = req_path.parent / f".{rid}.{os.getpid()}.tmp"
    tmp_req.write_text(json.dumps(req, ensure_ascii=False), encoding="utf-8")
    tmp_req.replace(req_path)

    pushed = _push_event_to_desktop(req)
    if not pushed:
        req["pushed_at"] = 0.0
        try:
            req_path.write_text(json.dumps(req, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    cond: threading.Condition = _get_runtime()["cond"]
    start = time.monotonic()
    deadline = start + effective_timeout

    while time.monotonic() < deadline:
        if resp_path.exists():
            try:
                resp = json.loads(resp_path.read_text(encoding="utf-8"))
                resp_path.unlink(missing_ok=True)
                req_path.unlink(missing_ok=True)
                resp.setdefault("client_id", client.get("client_id"))
                resp.setdefault("hostname", client.get("hostname"))
                return resp
            except Exception:
                pass
        elapsed = time.monotonic() - start
        wait_slice = 0.015 if elapsed < 0.6 else 0.045
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        with cond:
            cond.wait(timeout=min(wait_slice, remaining))

    if resp_path.exists():
        try:
            resp = json.loads(resp_path.read_text(encoding="utf-8"))
            resp_path.unlink(missing_ok=True)
            req_path.unlink(missing_ok=True)
            resp.setdefault("client_id", client.get("client_id"))
            resp.setdefault("hostname", client.get("hostname"))
            return resp
        except Exception:
            pass

    req_path.unlink(missing_ok=True)
    return {
        "ok": False,
        "client_id": client.get("client_id"),
        "hostname": client.get("hostname"),
        "error": f"Timeout ({effective_timeout:.0f}s): client '{client.get('hostname')}' did not respond to '{action}'.",
    }
