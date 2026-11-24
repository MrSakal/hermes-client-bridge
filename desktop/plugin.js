// Desktop client half of the client-bridge plugin (v2.0).
// Location: %LOCALAPPDATA%\hermes\desktop-plugins\client-bridge\plugin.js (Windows)
//       or: <HERMES_HOME>/desktop-plugins/client-bridge/plugin.js (macOS / Linux)
import { Button, host, Popover, PopoverContent, PopoverTrigger, STATUSBAR_AREAS } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'client-bridge'
const PLUGIN_VERSION = '2.0.0'
const EVENT_REQUEST = 'plugin.client-bridge.request'
const STORAGE_MODE_KEY = 'hermes.clientBridge.mode'
const STORAGE_CLIENT_ID_KEY = 'hermes.clientBridge.clientId'
const STORAGE_HOSTNAME_KEY = 'hermes.clientBridge.hostname'

const MODES = ['full', 'ask', 'readonly', 'off']
const MODE_LABELS = {
  full: '🖥️ Bridge: FULL',
  ask: '🛡️ Bridge: ASK',
  readonly: '👁️ Bridge: READ',
  off: '🔒 Bridge: OFF'
}
const IS_HU = typeof navigator !== 'undefined' && /^hu\b/i.test(navigator.language || '')
const L = IS_HU
  ? {
      modeDesc: {
        full: 'Olvasás, írás és parancsfuttatás automatikusan engedélyezve',
        ask: 'Olvasás szabad, írás és parancsfuttatás jóváhagyáshoz kötve',
        readonly: 'Csak könyvtár-, fájl- és vágólap-olvasás engedélyezett',
        off: 'Minden távoli kliensművelet letiltva'
      },
      truncated: n => `... [${n} karakter levágva a középső részből] ...`,
      runCmd: 'Parancs futtatása',
      bgPty: op => `Háttér PTY (${op})`,
      writeClip: 'Vágólap írása',
      writeFile: 'Fájl írása',
      deniedAsk: 'A műveletet a felhasználó elutasította a kliensgépen (ASK mód).',
      approvalToast: s => `Client Bridge jóváhagyás: ${s}`,
      allow: 'Engedélyez',
      deny: 'Elutasít',
      tooltip: v => `Client Bridge v${v} — kattints a vezérlőpanelhez`,
      pendingApprovals: n => `Jóváhagyásra vár (${n})`,
      runningPtys: n => `Futó háttér-terminálok (${n})`,
      recentActivity: 'Legutóbbi műveletek',
      emptyActivity: 'Még nem futott művelet ebben a munkamenetben.',
      syncNow: 'Szinkron most',
      updatePlugin: 'Plugin frissítés',
      autoUpdated: sha => `Client Bridge automatikusan frissült (#${sha})`,
      updateFailed: 'Client Bridge frissítés sikertelen'
    }
  : {
      modeDesc: {
        full: 'Read, write, and command execution allowed automatically',
        ask: 'Reads allowed; writes and commands require your approval',
        readonly: 'Only directory, file, and clipboard reads allowed',
        off: 'All remote client operations disabled'
      },
      truncated: n => `... [${n} characters truncated from middle] ...`,
      runCmd: 'Run command',
      bgPty: op => `Background PTY (${op})`,
      writeClip: 'Write clipboard',
      writeFile: 'Write file',
      deniedAsk: 'Operation denied by user on desktop client (ASK mode).',
      approvalToast: s => `Client Bridge approval: ${s}`,
      allow: 'Approve',
      deny: 'Deny',
      tooltip: v => `Client Bridge v${v} — click to open control panel`,
      pendingApprovals: n => `Pending approvals (${n})`,
      runningPtys: n => `Active background PTYs (${n})`,
      recentActivity: 'Recent operations',
      emptyActivity: 'No operations executed in this session yet.',
      syncNow: 'Sync now',
      updatePlugin: 'Update plugin',
      autoUpdated: sha => `Client Bridge auto-updated (#${sha})`,
      updateFailed: 'Client Bridge update failed'
    }

const MAX_HANDLED_IDS = 300
const MAX_OUTPUT_CHARS = 512 * 1024
const BG_BUFFER_CHARS = 128 * 1024
const WARM_IDLE_MS = 5 * 60 * 1000

let currentMode = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_MODE_KEY)) || 'full'
if (!MODES.includes(currentMode)) currentMode = 'full'

const uiState = {
  mode: currentMode,
  activeCount: 0,
  onBattery: false,
  pluginSha: '',
  auditLog: [],
  approvals: [],
  bgPtysCount: 0
}
const uiListeners = new Set()
function emitUi() {
  const snap = {
    mode: uiState.mode,
    activeCount: uiState.activeCount,
    onBattery: uiState.onBattery,
    pluginSha: uiState.pluginSha,
    auditLog: uiState.auditLog.slice(),
    approvals: uiState.approvals.slice(),
    bgPtysCount: uiState.bgPtysCount
  }
  for (const fn of uiListeners) {
    try { fn(snap) } catch {}
  }
}

function setBridgeMode(nextMode) {
  currentMode = MODES.includes(nextMode) ? nextMode : 'full'
  uiState.mode = currentMode
  try { localStorage.setItem(STORAGE_MODE_KEY, currentMode) } catch {}
  emitUi()
}

function recordAudit(entry) {
  uiState.auditLog.unshift(entry)
  if (uiState.auditLog.length > 12) uiState.auditLog.length = 12
  emitUi()
}

const handledReqIds = new Set()
function rememberHandledReq(reqId) {
  handledReqIds.add(reqId)
  while (handledReqIds.size > MAX_HANDLED_IDS) {
    const oldest = handledReqIds.values().next().value
    if (oldest === undefined) break
    handledReqIds.delete(oldest)
  }
}

function stripAnsi(str) {
  return String(str || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
}

function capOutput(str, limit = MAX_OUTPUT_CHARS) {
  const s = String(str || '')
  if (s.length <= limit) return s
  const half = Math.floor(limit / 2) - 64
  return `${s.slice(0, half)}\n\n${L.truncated(s.length - half * 2)}\n\n${s.slice(-half)}`
}

async function sha256Short(text) {
  try {
    const bytes = new TextEncoder().encode(String(text || ''))
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return hex.slice(0, 16)
  } catch {
    return ''
  }
}

function joinClientPath(isWin, ...parts) {
  const sep = isWin ? '\\' : '/'
  return parts
    .filter(Boolean)
    .map((p, idx) => (idx === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)
}

function psQuote(val) {
  return `'${String(val ?? '').replace(/'/g, "''")}'`
}

function shQuote(val) {
  return `'${String(val ?? '').replace(/'/g, `'\\''`)}'`
}

const seenSessionIds = []
function readHostSessions() {
  const st = host?.state || {}
  const focusedSid = String(st.focusedSessionId?.get?.() || '').trim()
  const focusedStoredSid = String(st.focusedStoredSessionId?.get?.() || '').trim()
  const activeSid = String(st.activeSessionId?.get?.() || host?.activeSessionId?.get?.() || '').trim()

  for (const sid of [focusedSid, focusedStoredSid, activeSid]) {
    if (sid) {
      const idx = seenSessionIds.indexOf(sid)
      if (idx >= 0) seenSessionIds.splice(idx, 1)
      seenSessionIds.unshift(sid)
    }
  }
  if (seenSessionIds.length > 12) seenSessionIds.length = 12

  return {
    focused_session_id: focusedSid,
    focused_stored_session_id: focusedStoredSid,
    active_chat_session_id: activeSid || focusedStoredSid || focusedSid,
    ui_session_ids: seenSessionIds.slice()
  }
}

function subscribeAtom(atom, cb) {
  if (!atom) return null
  if (typeof atom.listen === 'function') return atom.listen(cb)
  if (typeof atom.subscribe === 'function') {
    let first = true
    return atom.subscribe(val => {
      if (first) { first = false; return }
      cb(val)
    })
  }
  return null
}

let staticMachineCache = null

async function detectLocalIdentity({ rescanPlugins = false, bgPtys = null } = {}) {
  const d = window.hermesDesktop
  if (!staticMachineCache || rescanPlugins) {
    let desktopPluginsRoot = staticMachineCache?.desktopPluginsRoot || ''
    let machineProfile = staticMachineCache?.machineProfile || {}
    let installedPlugins = staticMachineCache?.installedPlugins || []

    try {
      if (!desktopPluginsRoot) desktopPluginsRoot = (await d?.desktopPluginsRoot?.()) || ''
    } catch {}
    try {
      if (!machineProfile?.hostname) machineProfile = (await d?.getMachineProfile?.()) || {}
    } catch {}
    try {
      if (desktopPluginsRoot && d?.readDir) {
        const dirRes = await d.readDir(desktopPluginsRoot)
        const list = Array.isArray(dirRes?.entries) ? dirRes.entries : (Array.isArray(dirRes) ? dirRes : [])
        installedPlugins = list
          .filter(e => e?.isDirectory && e?.name && e.name !== 'catalog')
          .map(e => ({ id: e.name, dirPath: e.path }))
      }
    } catch {}

    const isWin = desktopPluginsRoot.includes('\\') || String(navigator.platform || '').toLowerCase().includes('win')
    let homeDir = ''
    let user = String(machineProfile?.username || '')
    if (desktopPluginsRoot) {
      if (/\\AppData\\/i.test(desktopPluginsRoot)) {
        homeDir = desktopPluginsRoot.split(/\\AppData\\/i)[0]
      } else {
        const idx = desktopPluginsRoot.indexOf('.hermes')
        if (idx > 0) homeDir = desktopPluginsRoot.slice(0, idx).replace(/[\\/]+$/, '')
      }
      if (homeDir && !user) {
        const parts = homeDir.split(/[\\/]/)
        user = parts[parts.length - 1] || ''
      }
    }

    let hostname = ''
    try { hostname = localStorage.getItem(STORAGE_HOSTNAME_KEY) || '' } catch {}
    if (!hostname && machineProfile?.hostname) hostname = String(machineProfile.hostname)

    const platform = machineProfile?.platform || (isWin ? 'win32' : 'posix')
    const arch = machineProfile?.arch || ''
    let clientId = ''
    try { clientId = localStorage.getItem(STORAGE_CLIENT_ID_KEY) || '' } catch {}
    if (!clientId || (hostname && clientId.startsWith('desktop-'))) {
      const base = (hostname || user || 'desktop').toLowerCase().replace(/[^a-z0-9_-]/g, '-')
      const suffix = clientId.split('-').pop() || Math.random().toString(36).slice(2, 6)
      clientId = `${base}-${platform}-${suffix}`
      try { localStorage.setItem(STORAGE_CLIENT_ID_KEY, clientId) } catch {}
    }

    let localSha = staticMachineCache?.localSha || ''
    if (desktopPluginsRoot && (!localSha || rescanPlugins)) {
      try {
        const selfPath = joinClientPath(isWin, desktopPluginsRoot, PLUGIN_ID, 'plugin.js')
        const srcRes = d?.readPluginSource ? await d.readPluginSource(selfPath) : await d?.readFileText?.(selfPath)
        const text = typeof srcRes === 'string' ? srcRes : (srcRes?.text ?? srcRes?.content)
        if (text) localSha = await sha256Short(text)
      } catch {}
    }
    if (localSha) uiState.pluginSha = localSha

    staticMachineCache = {
      clientId,
      hostname: hostname || user || 'desktop-client',
      platform,
      arch,
      user,
      homeDir,
      desktopPluginsRoot,
      installedPlugins,
      machineProfile,
      isWin,
      localSha
    }
  }

  const sessions = readHostSessions()
  const activePtysList = bgPtys
    ? Array.from(bgPtys.values())
        .filter(p => !p.exited)
        .map(p => ({ pty_id: p.id, command: p.command.slice(0, 80), cwd: p.cwd || '' }))
    : []

  return {
    client_id: staticMachineCache.clientId,
    hostname: staticMachineCache.hostname,
    platform: staticMachineCache.platform,
    os_version: navigator.userAgent || '',
    arch: staticMachineCache.arch,
    user: staticMachineCache.user,
    home_dir: staticMachineCache.homeDir,
    desktop_plugins_root: staticMachineCache.desktopPluginsRoot,
    installed_desktop_plugins: staticMachineCache.installedPlugins,
    mode: currentMode,
    on_battery: uiState.onBattery,
    plugin_sha: staticMachineCache.localSha || '',
    active_ptys: activePtysList,
    ...sessions,
    machine_profile: staticMachineCache.machineProfile,
    isWin: staticMachineCache.isWin
  }
}

function createShellManager() {
  let warm = null
  const bgPtys = new Map()

  const disposeWarm = () => {
    if (!warm) return
    const cur = warm
    warm = null
    if (cur.idleTimer) clearTimeout(cur.idleTimer)
    try { cur.unsubData?.() } catch {}
    try { cur.unsubExit?.() } catch {}
    try { window.hermesDesktop?.terminal?.dispose?.(cur.id) } catch {}
  }

  const touchWarmIdle = () => {
    if (!warm) return
    if (warm.idleTimer) clearTimeout(warm.idleTimer)
    warm.idleTimer = setTimeout(() => {
      if (warm && !warm.busy) disposeWarm()
    }, WARM_IDLE_MS)
  }

  const ensureWarmShell = async (defaultCwd, isWinHint) => {
    if (warm && !warm.dead) return warm
    const d = window.hermesDesktop
    if (!d?.terminal?.start) throw new Error('window.hermesDesktop.terminal.start is not available')

    const startRes = await d.terminal.start({
      connectionId: 'local',
      cwd: defaultCwd || undefined,
      cols: 200,
      rows: 45
    })
    if (!startRes?.id || startRes?.unavailable) {
      throw new Error(startRes?.unavailable || startRes?.error || 'Failed to start warm local shell')
    }

    const termId = startRes.id
    const shellName = String(startRes.shell || '').toLowerCase()
    const isCmd = shellName.includes('cmd.exe') || shellName === 'cmd'
    const isWin = isWinHint !== null && isWinHint !== undefined
      ? Boolean(isWinHint)
      : (isCmd || shellName.includes('powershell') || shellName.includes('pwsh') || shellName.includes('.exe'))

    const dataListeners = new Set()
    const exitListeners = new Set()
    const entry = {
      id: termId,
      shell: startRes.shell || '',
      isWin,
      isCmd,
      busy: true,
      dead: false,
      idleTimer: null,
      dataListeners,
      exitListeners,
      unsubData: null,
      unsubExit: null
    }

    entry.unsubData = d.terminal.onData(termId, chunk => {
      const text = String(typeof chunk === 'string' ? chunk : (chunk?.data || ''))
      for (const fn of dataListeners) {
        try { fn(text) } catch {}
      }
    })
    entry.unsubExit = d.terminal.onExit(termId, ev => {
      entry.dead = true
      if (warm === entry) warm = null
      for (const fn of exitListeners) {
        try { fn(ev) } catch {}
      }
    })

    Promise.resolve(d.terminal.attach?.(termId)).catch(() => {})

    const readyTok = Math.random().toString(36).slice(2, 10)
    const readyMarker = `__CB_READY_${readyTok}__`
    await new Promise((resolve, reject) => {
      let buf = ''
      const timeout = setTimeout(() => {
        dataListeners.delete(onChunk)
        entry.busy = false
        resolve()
      }, 4000)

      const onChunk = chunk => {
        buf += chunk
        if (stripAnsi(buf).includes(readyMarker)) {
          clearTimeout(timeout)
          dataListeners.delete(onChunk)
          resolve()
        }
      }
      dataListeners.add(onChunk)

      let initCmd = ''
      if (isCmd) {
        initCmd = `@echo off\r\necho ${readyMarker}\r\n`
      } else if (isWin) {
        initCmd = ` try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch {}; try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding } catch {}; Write-Output ('__CB_READY_' + '${readyTok}__')\r\n`
      } else {
        initCmd = ` HISTFILE=/dev/null; unset HISTFILE; export TERM=xterm-256color; printf "%s\\n" "${readyMarker}"\n`
      }
      try {
        d.terminal.write(termId, initCmd)
      } catch (err) {
        clearTimeout(timeout)
        dataListeners.delete(onChunk)
        reject(err)
      }
    })

    entry.busy = false
    warm = entry
    touchWarmIdle()
    return entry
  }

  const runOnWarmShell = async (shellEntry, command, cwd, timeoutMs) => {
    const d = window.hermesDesktop
    shellEntry.busy = true
    if (shellEntry.idleTimer) clearTimeout(shellEntry.idleTimer)

    const reqToken = Math.random().toString(36).slice(2, 10)
    const beginMarker = `__CB_BEGIN_${reqToken}__`
    const endPrefix = `__CB_END_${reqToken}_`

    return new Promise(resolve => {
      let rawBuf = ''
      let settled = false
      let timer = null

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        shellEntry.dataListeners.delete(onData)
        shellEntry.exitListeners.delete(onExit)
      }

      const finish = (res, killShell = false) => {
        if (settled) return
        settled = true
        cleanup()
        if (killShell) {
          disposeWarm()
        } else {
          shellEntry.busy = false
          touchWarmIdle()
        }
        resolve(res)
      }

      const checkMarkers = () => {
        const clean = stripAnsi(rawBuf)
        const bIdx = clean.lastIndexOf(beginMarker)
        if (bIdx < 0) return
        const afterBegin = clean.slice(bIdx + beginMarker.length)
        const endMatch = afterBegin.match(new RegExp(`${endPrefix}(-?\\d+)__`))
        if (endMatch) {
          const exitCode = parseInt(endMatch[1], 10)
          const body = afterBegin
            .slice(0, endMatch.index)
            .replace(/__CB_END_[a-z0-9]+_[^\r\n]*/g, '')
            .replace(/^[\r\n]+/, '')
            .replace(/[\r\n]+$/, '')
          finish({
            ok: true,
            exit_code: Number.isNaN(exitCode) ? 0 : exitCode,
            stdout: capOutput(body),
            shell: shellEntry.shell,
            warm_shell: true
          })
        }
      }

      const onData = chunk => {
        rawBuf += chunk
        if (rawBuf.length > MAX_OUTPUT_CHARS * 1.5) {
          const bIdx = rawBuf.lastIndexOf(beginMarker)
          rawBuf = (bIdx >= 0 ? beginMarker : '') + capOutput(bIdx >= 0 ? rawBuf.slice(bIdx + beginMarker.length) : rawBuf)
        }
        checkMarkers()
      }

      const onExit = ev => {
        checkMarkers()
        if (!settled) {
          const clean = stripAnsi(rawBuf)
          const bIdx = clean.lastIndexOf(beginMarker)
          const body = bIdx >= 0 ? clean.slice(bIdx + beginMarker.length).trim() : clean.trim()
          const code = typeof ev?.code === 'number' ? ev.code : (typeof ev?.exitCode === 'number' ? ev.exitCode : 0)
          finish({ ok: true, exit_code: code, stdout: capOutput(body), shell: shellEntry.shell, warm_shell: true }, true)
        }
      }

      shellEntry.dataListeners.add(onData)
      shellEntry.exitListeners.add(onExit)

      const limitMs = Math.max(1000, Number(timeoutMs) || 25000)
      timer = setTimeout(() => {
        const clean = stripAnsi(rawBuf)
        const bIdx = clean.lastIndexOf(beginMarker)
        const partial = bIdx >= 0 ? clean.slice(bIdx + beginMarker.length).trim() : clean.trim()
        finish({
          ok: false,
          error: `Command timed out after ${limitMs}ms (warm shell recycled)`,
          stdout: capOutput(partial),
          shell: shellEntry.shell
        }, true)
      }, limitMs)

      let script = ''
      if (shellEntry.isCmd) {
        const cdPart = cwd ? `cd /d "${String(cwd).replace(/"/g, '')}" & ` : ''
        script = `${cdPart}echo ${beginMarker}& (${command}) & echo ${endPrefix}%ERRORLEVEL%__\r\n`
      } else if (shellEntry.isWin) {
        const cdPart = cwd ? `Set-Location -LiteralPath ${psQuote(cwd)}; ` : ''
        script = ` $ErrorActionPreference='Continue'; $global:LASTEXITCODE=0; Write-Output ('__CB_BEGIN_' + '${reqToken}__'); try { ${cdPart}& { ${command} } 2>&1 | Out-String -Width 4096 | Write-Output } catch { Write-Output ($_.Exception.Message); if ($global:LASTEXITCODE -eq 0) { $global:LASTEXITCODE = 1 } }; $__ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }; Write-Output ('__CB_END_' + '${reqToken}_' + $__ec + '__')\r\n`
      } else {
        const cdPart = cwd ? `cd -- ${shQuote(cwd)} && ` : ''
        script = ` printf "%s\\n" "${beginMarker}"; { ${cdPart}${command} ; }; __ec=$?; printf "\\n%s%s__\\n" "${endPrefix}" "$__ec"\n`
      }

      try {
        d.terminal.write(shellEntry.id, script)
      } catch (err) {
        finish({ ok: false, error: String(err?.message || err) }, true)
      }
    })
  }

  const runOneOffCommand = async (command, cwd, timeoutMs, isWinHint) => {
    const d = window.hermesDesktop
    const startRes = await d.terminal.start({
      connectionId: 'local',
      cwd: cwd || undefined,
      cols: 200,
      rows: 45
    })
    if (!startRes?.id || startRes?.unavailable) {
      return { ok: false, error: startRes?.unavailable || startRes?.error || 'Failed to start local terminal' }
    }
    const termId = startRes.id
    const shellName = String(startRes.shell || '').toLowerCase()
    const isCmd = shellName.includes('cmd.exe') || shellName === 'cmd'
    const isWin = isWinHint !== null && isWinHint !== undefined
      ? Boolean(isWinHint)
      : (isCmd || shellName.includes('powershell') || shellName.includes('pwsh') || shellName.includes('.exe'))

    const reqToken = Math.random().toString(36).slice(2, 10)
    const beginMarker = `__CB_BEGIN_${reqToken}__`
    const endPrefix = `__CB_END_${reqToken}_`

    return new Promise(resolve => {
      let rawBuf = ''
      let settled = false
      let timer = null
      let unsubData = null
      let unsubExit = null

      const finish = res => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try { unsubData?.() } catch {}
        try { unsubExit?.() } catch {}
        try { d.terminal.dispose(termId) } catch {}
        resolve(res)
      }

      const checkBuffer = () => {
        const clean = stripAnsi(rawBuf)
        const bIdx = clean.lastIndexOf(beginMarker)
        if (bIdx < 0) return
        const afterBegin = clean.slice(bIdx + beginMarker.length)
        const endMatch = afterBegin.match(new RegExp(`${endPrefix}(-?\\d+)__`))
        if (endMatch) {
          const exitCode = parseInt(endMatch[1], 10)
          const body = afterBegin
            .slice(0, endMatch.index)
            .replace(/__CB_END_[a-z0-9]+_[^\r\n]*/g, '')
            .replace(/^[\r\n]+/, '')
            .replace(/[\r\n]+$/, '')
          finish({ ok: true, exit_code: Number.isNaN(exitCode) ? 0 : exitCode, stdout: capOutput(body), shell: startRes.shell, warm_shell: false })
        }
      }

      unsubData = d.terminal.onData(termId, data => {
        rawBuf += String(typeof data === 'string' ? data : (data?.data || ''))
        if (rawBuf.length > MAX_OUTPUT_CHARS * 1.5) rawBuf = capOutput(rawBuf)
        checkBuffer()
      })
      unsubExit = d.terminal.onExit(termId, ev => {
        checkBuffer()
        if (!settled) {
          const clean = stripAnsi(rawBuf)
          const bIdx = clean.lastIndexOf(beginMarker)
          const body = bIdx >= 0 ? clean.slice(bIdx + beginMarker.length).trim() : clean.trim()
          const code = typeof ev?.code === 'number' ? ev.code : (typeof ev?.exitCode === 'number' ? ev.exitCode : 0)
          finish({ ok: true, exit_code: code, stdout: capOutput(body), shell: startRes.shell, warm_shell: false })
        }
      })

      Promise.resolve(d.terminal.attach?.(termId)).catch(() => {})

      const limitMs = Math.max(1000, Number(timeoutMs) || 25000)
      timer = setTimeout(() => {
        const clean = stripAnsi(rawBuf)
        const bIdx = clean.lastIndexOf(beginMarker)
        const partial = bIdx >= 0 ? clean.slice(bIdx + beginMarker.length).trim() : clean.trim()
        finish({ ok: false, error: `Command timed out after ${limitMs}ms`, stdout: capOutput(partial), shell: startRes.shell })
      }, limitMs)

      setTimeout(() => {
        let script = ''
        if (isCmd) {
          script = `echo ${beginMarker}& (${command}) & echo ${endPrefix}%ERRORLEVEL%__& exit\r\n`
        } else if (isWin) {
          script = ` try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch {}; $ErrorActionPreference='Continue'; Write-Output ('__CB_BEGIN_' + '${reqToken}__'); try { & { ${command} } 2>&1 | Out-String -Width 4096 | Write-Output } catch { Write-Output ($_.Exception.Message) }; $ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }; Write-Output ('__CB_END_' + '${reqToken}_' + $ec + '__'); exit\r\n`
        } else {
          script = ` HISTFILE=/dev/null; printf "%s\\n" "${beginMarker}"; { ${command} ; }; _ec=$?; printf "\\n%s%s__\\n" "${endPrefix}" "$_ec"; exit\n`
        }
        d.terminal.write(termId, script)
      }, 120)
    })
  }

  const execCommand = async (command, cwd, timeoutMs = 25000, isWinHint = null, freshShell = false, defaultHome = '') => {
    if (!freshShell && (!warm || !warm.busy)) {
      try {
        const shellEntry = await ensureWarmShell(defaultHome || cwd, isWinHint)
        if (!shellEntry.busy) {
          return await runOnWarmShell(shellEntry, command, cwd, timeoutMs)
        }
      } catch {}
    }
    return runOneOffCommand(command, cwd, timeoutMs, isWinHint)
  }

  const updateBgUiCount = () => {
    let running = 0
    for (const p of bgPtys.values()) {
      if (!p.exited) running++
    }
    uiState.bgPtysCount = running
    emitUi()
  }

  const managePty = async (params, identity, onPtyChanged) => {
    const d = window.hermesDesktop
    const op = String(params?.op || 'list').toLowerCase()

    if (op === 'reset_shell') {
      disposeWarm()
      return { ok: true, message: 'Warm shell reset; next exec will spawn a fresh warm session.' }
    }

    if (op === 'list') {
      return {
        ok: true,
        ptys: Array.from(bgPtys.values()).map(p => ({
          pty_id: p.id,
          command: p.command,
          cwd: p.cwd,
          shell: p.shell,
          running: !p.exited,
          exit_code: p.exitCode,
          uptime_seconds: Math.round((Date.now() - p.startedAt) / 1000),
          output_tail: stripAnsi(p.buf).slice(-1500)
        }))
      }
    }

    if (op === 'start') {
      const cmd = String(params?.command || '').trim()
      if (!cmd) throw new Error('command is required to start a background PTY')
      const cwd = params?.cwd || identity.home_dir || undefined
      const startRes = await d.terminal.start({
        connectionId: 'local',
        cwd,
        cols: 200,
        rows: 45
      })
      if (!startRes?.id || startRes?.unavailable) {
        throw new Error(startRes?.unavailable || startRes?.error || 'Failed to start background PTY')
      }
      const ptyId = `pty-${Math.random().toString(36).slice(2, 8)}`
      const shellName = String(startRes.shell || '').toLowerCase()
      const isWin = identity.isWin || shellName.includes('powershell') || shellName.includes('pwsh') || shellName.includes('cmd')
      const rec = {
        id: ptyId,
        termId: startRes.id,
        command: cmd,
        cwd: cwd || '',
        shell: startRes.shell || '',
        startedAt: Date.now(),
        exited: false,
        exitCode: null,
        buf: '',
        unsubData: null,
        unsubExit: null
      }
      rec.unsubData = d.terminal.onData(startRes.id, chunk => {
        rec.buf += String(typeof chunk === 'string' ? chunk : (chunk?.data || ''))
        if (rec.buf.length > BG_BUFFER_CHARS) {
          rec.buf = rec.buf.slice(-BG_BUFFER_CHARS)
        }
      })
      rec.unsubExit = d.terminal.onExit(startRes.id, ev => {
        rec.exited = true
        rec.exitCode = typeof ev?.code === 'number' ? ev.code : (typeof ev?.exitCode === 'number' ? ev.exitCode : 0)
        updateBgUiCount()
        onPtyChanged?.()
      })
      Promise.resolve(d.terminal.attach?.(startRes.id)).catch(() => {})
      bgPtys.set(ptyId, rec)
      updateBgUiCount()

      const eol = isWin ? '\r\n' : '\n'
      const initPrefix = isWin && !shellName.includes('cmd')
        ? `try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch {}; `
        : (!isWin ? `HISTFILE=/dev/null; ` : '')
      d.terminal.write(startRes.id, `${initPrefix}${cmd}${eol}`)

      await new Promise(r => setTimeout(r, 350))
      onPtyChanged?.()
      return {
        ok: true,
        pty_id: ptyId,
        shell: rec.shell,
        running: !rec.exited,
        exit_code: rec.exitCode,
        initial_output: stripAnsi(rec.buf).trim()
      }
    }

    const ptyId = String(params?.pty_id || '').trim()
    const rec = bgPtys.get(ptyId)
    if (!rec) throw new Error(`Background PTY '${ptyId}' not found`)

    if (op === 'read') {
      return {
        ok: true,
        pty_id: rec.id,
        command: rec.command,
        running: !rec.exited,
        exit_code: rec.exitCode,
        uptime_seconds: Math.round((Date.now() - rec.startedAt) / 1000),
        output: stripAnsi(rec.buf)
      }
    }

    if (op === 'write') {
      if (rec.exited) throw new Error(`PTY '${ptyId}' has already exited (code ${rec.exitCode})`)
      const input = String(params?.command ?? '')
      const eol = input.endsWith('\n') ? '' : (identity.isWin ? '\r\n' : '\n')
      d.terminal.write(rec.termId, input + eol)
      await new Promise(r => setTimeout(r, 250))
      return {
        ok: true,
        pty_id: rec.id,
        running: !rec.exited,
        output_tail: stripAnsi(rec.buf).slice(-4000)
      }
    }

    if (op === 'kill') {
      try { rec.unsubData?.() } catch {}
      try { rec.unsubExit?.() } catch {}
      try { d.terminal.dispose(rec.termId) } catch {}
      rec.exited = true
      bgPtys.delete(ptyId)
      updateBgUiCount()
      onPtyChanged?.()
      return { ok: true, pty_id: ptyId, killed: true }
    }

    throw new Error(`Unsupported pty_manage op: ${op}`)
  }

  const killPtyById = ptyId => {
    const rec = bgPtys.get(ptyId)
    if (!rec) return
    try { rec.unsubData?.() } catch {}
    try { rec.unsubExit?.() } catch {}
    try { window.hermesDesktop?.terminal?.dispose?.(rec.termId) } catch {}
    bgPtys.delete(ptyId)
    updateBgUiCount()
  }

  const disposeAll = () => {
    disposeWarm()
    for (const ptyId of Array.from(bgPtys.keys())) {
      killPtyById(ptyId)
    }
  }

  return { execCommand, managePty, bgPtys, killPtyById, disposeAll }
}

function requiresApproval(action, params) {
  if (currentMode !== 'ask') return false
  if (action === 'client_info' || action === 'read_dir' || action === 'read_file') return false
  if (action === 'pty_manage' && ['list', 'read'].includes(String(params?.op || ''))) return false
  return true
}

function summarizeForApproval(action, params) {
  if (action === 'exec') {
    return { summary: L.runCmd, detail: String(params?.command || '').slice(0, 180) }
  }
  if (action === 'pty_manage') {
    return { summary: L.bgPty(params?.op), detail: String(params?.command || params?.pty_id || '').slice(0, 180) }
  }
  if (action === 'write_file') {
    const label = params?.clipboard ? L.writeClip : L.writeFile
    return { summary: label, detail: String(params?.path || params?.content || '').slice(0, 180) }
  }
  return { summary: action, detail: JSON.stringify(params || {}).slice(0, 140) }
}

function requestUserApproval(ctx, req) {
  const { summary, detail } = summarizeForApproval(req.action, req.params)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeItem()
      reject(new Error('ASK mode approval timed out (user did not approve within 85s).'))
    }, 85000)

    const removeItem = () => {
      clearTimeout(timer)
      const idx = uiState.approvals.findIndex(a => a.reqId === req.req_id)
      if (idx >= 0) {
        uiState.approvals.splice(idx, 1)
        emitUi()
      }
    }

    const decide = allow => {
      removeItem()
      if (allow) resolve(true)
      else reject(new Error(L.deniedAsk))
    }

    uiState.approvals.push({
      reqId: req.req_id,
      action: req.action,
      summary,
      detail,
      createdAt: Date.now(),
      decide
    })
    emitUi()

    try {
      host.notify({
        kind: 'warning',
        title: L.approvalToast(summary),
        message: detail || req.action,
        action: { label: L.allow, onClick: () => decide(true) }
      })
    } catch {}
    try {
      if (typeof document !== 'undefined' && !document.hasFocus()) {
        ctx.os?.notify?.({
          title: `Hermes Client Bridge: ${summary}`,
          body: detail || req.action,
          activate: true
        })
      }
    } catch {}
  })
}

async function executeBridgeAction(ctx, shellMgr, req, identity, onStateChanged) {
  const d = window.hermesDesktop
  const action = String(req?.action || '')
  const params = req?.params || {}

  if (currentMode === 'off') {
    throw new Error('Client Bridge is currently set to OFF on this desktop.')
  }
  const readonlySafe = ['client_info', 'read_dir', 'read_file']
  if (currentMode === 'readonly' && !readonlySafe.includes(action)) {
    throw new Error(`Client Bridge is in READ-ONLY mode; action '${action}' is blocked.`)
  }

  if (requiresApproval(action, params)) {
    await requestUserApproval(ctx, req)
  }

  switch (action) {
    case 'client_info': {
      return await detectLocalIdentity({ rescanPlugins: true, bgPtys: shellMgr.bgPtys })
    }

    case 'read_dir': {
      const targetPath = params.path || identity.home_dir || '.'
      const entries = await d.readDir(targetPath)
      return { path: targetPath, entries }
    }

    case 'read_file': {
      if (params.clipboard) {
        const text = (await d?.readClipboard?.()) || ''
        return { clipboard: true, content: text }
      }
      const targetPath = String(params.path || '')
      if (!targetPath) throw new Error('path is required')
      const res = await d.readFileText(targetPath)
      if (res && res.error) throw new Error(res.error)
      return { path: targetPath, ...(res || {}) }
    }

    case 'write_file': {
      const content = String(params.content ?? '')
      if (params.clipboard) {
        const ok = await (ctx.os?.writeClipboard ? ctx.os.writeClipboard(content) : d.writeClipboard(content))
        return { clipboard: true, ok: Boolean(ok), chars: content.length }
      }
      const targetPath = String(params.path || '')
      if (!targetPath) throw new Error('path is required')
      const res = await d.writeTextFile(targetPath, content)
      if (res && res.error) throw new Error(res.error)
      if (/desktop-plugins/i.test(targetPath)) {
        try {
          await d.reconcileDesktopPlugins?.()
          await detectLocalIdentity({ rescanPlugins: true, bgPtys: shellMgr.bgPtys })
          onStateChanged?.()
        } catch {}
      }
      return { path: targetPath, bytes: content.length, ...(res || {}) }
    }

    case 'exec': {
      const command = String(params.command || '').trim()
      if (!command) throw new Error('command is required')
      const timeoutMs = Number(params.timeout_ms) || 25000
      const cwd = params.cwd || identity.home_dir || undefined
      const res = await shellMgr.execCommand(command, cwd, timeoutMs, identity.isWin, Boolean(params.fresh_shell), identity.home_dir)
      if (!res.ok) {
        throw new Error(`${res.error || 'Command failed'}${res.stdout ? `\nOutput:\n${res.stdout}` : ''}`)
      }
      return res
    }

    case 'pty_manage': {
      return await shellMgr.managePty(params, identity, onStateChanged)
    }

    default:
      throw new Error(`Unsupported action: ${action}`)
  }
}

function StatusBarControl({ onManualSync, onForceSelfUpdate, shellMgr }) {
  const [snap, setSnap] = useState(() => ({
    mode: uiState.mode,
    activeCount: uiState.activeCount,
    onBattery: uiState.onBattery,
    pluginSha: uiState.pluginSha,
    auditLog: uiState.auditLog.slice(),
    approvals: uiState.approvals.slice(),
    bgPtysCount: uiState.bgPtysCount
  }))

  useEffect(() => {
    const fn = next => setSnap(next)
    uiListeners.add(fn)
    return () => uiListeners.delete(fn)
  }, [])

  const selectMode = async m => {
    setBridgeMode(m)
    try {
      await onManualSync?.()
      host.notify({ kind: 'info', message: `Client Bridge: ${m.toUpperCase()}` })
    } catch {}
  }

  const labelParts = [MODE_LABELS[snap.mode] || MODE_LABELS.full]
  if (snap.activeCount > 0) labelParts.push('⚡')
  if (snap.bgPtysCount > 0) labelParts.push(`(${snap.bgPtysCount} PTY)`)
  if (snap.approvals.length > 0) labelParts.push(`[${snap.approvals.length}!]`)

  const triggerBtn = jsx('button', {
    type: 'button',
    title: L.tooltip(PLUGIN_VERSION),
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-secondary) hover:text-(--ui-text-primary) transition-colors',
    style: snap.approvals.length > 0 ? { color: 'var(--ui-accent)', fontWeight: 600 } : undefined,
    children: labelParts.join(' ')
  })

  if (!Popover || !PopoverTrigger || !PopoverContent) {
    return jsx('button', {
      type: 'button',
      className: 'px-1.5 text-[0.6875rem] text-(--ui-text-secondary) hover:text-(--ui-text-primary)',
      onClick: () => selectMode(MODES[(MODES.indexOf(snap.mode) + 1) % MODES.length]),
      children: labelParts.join(' ')
    })
  }

  const livePtys = shellMgr ? Array.from(shellMgr.bgPtys.values()).filter(p => !p.exited) : []

  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, { asChild: true, children: triggerBtn }),
      jsxs(PopoverContent, {
        align: 'end',
        side: 'top',
        className: 'w-80 p-3 text-xs flex flex-col gap-2.5',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between',
            children: [
              jsx('span', {
                className: 'font-semibold text-(--ui-text-primary)',
                children: `Client Bridge v${PLUGIN_VERSION}`
              }),
              jsx('span', {
                className: 'text-[0.65rem] text-(--ui-text-tertiary) font-mono',
                children: `${snap.pluginSha ? `#${snap.pluginSha.slice(0, 8)}` : ''}${snap.onBattery ? ' · 🔋' : ''}`
              })
            ]
          }),

          jsx('div', {
            className: 'grid grid-cols-4 gap-1',
            children: MODES.map(m =>
              jsx(Button, {
                key: m,
                size: 'xs',
                variant: snap.mode === m ? 'primary' : 'secondary',
                onClick: () => selectMode(m),
                children: m.toUpperCase()
              })
            )
          }),
          jsx('div', {
            className: 'text-[0.68rem] text-(--ui-text-tertiary)',
            children: L.modeDesc[snap.mode]
          }),

          snap.approvals.length > 0 && jsxs('div', {
            className: 'flex flex-col gap-1.5 p-2 rounded border',
            style: { borderColor: 'var(--ui-accent)' },
            children: [
              jsx('div', {
                className: 'font-semibold text-(--ui-text-primary)',
                children: L.pendingApprovals(snap.approvals.length)
              }),
              ...snap.approvals.map(a =>
                jsxs('div', {
                  key: a.reqId,
                  className: 'flex flex-col gap-1 pt-1 border-t',
                  style: { borderColor: 'var(--ui-stroke-secondary)' },
                  children: [
                    jsx('div', { className: 'font-medium text-(--ui-text-primary)', children: a.summary }),
                    jsx('div', { className: 'font-mono text-[0.65rem] text-(--ui-text-secondary) break-all', children: a.detail }),
                    jsxs('div', {
                      className: 'flex gap-1.5 pt-0.5',
                      children: [
                        jsx(Button, { size: 'xs', variant: 'primary', onClick: () => a.decide(true), children: L.allow }),
                        jsx(Button, { size: 'xs', variant: 'secondary', onClick: () => a.decide(false), children: L.deny })
                      ]
                    })
                  ]
                })
              )
            ]
          }),

          livePtys.length > 0 && jsxs('div', {
            className: 'flex flex-col gap-1 pt-1 border-t',
            style: { borderColor: 'var(--ui-stroke-secondary)' },
            children: [
              jsx('div', {
                className: 'text-[0.68rem] font-medium text-(--ui-text-secondary)',
                children: L.runningPtys(livePtys.length)
              }),
              ...livePtys.map(p =>
                jsxs('div', {
                  key: p.id,
                  className: 'flex items-center justify-between gap-2 text-[0.68rem]',
                  children: [
                    jsx('span', {
                      className: 'font-mono text-(--ui-text-tertiary) truncate',
                      title: p.command,
                      children: `${p.id}: ${p.command}`
                    }),
                    jsx(Button, {
                      size: 'xs',
                      variant: 'secondary',
                      onClick: () => {
                        shellMgr.killPtyById(p.id)
                        onManualSync?.()
                      },
                      children: 'Stop'
                    })
                  ]
                })
              )
            ]
          }),

          jsxs('div', {
            className: 'flex flex-col gap-1 pt-1 border-t',
            style: { borderColor: 'var(--ui-stroke-secondary)' },
            children: [
              jsx('div', {
                className: 'text-[0.68rem] font-medium text-(--ui-text-secondary)',
                children: L.recentActivity
              }),
              snap.auditLog.length === 0
                ? jsx('div', { className: 'text-[0.68rem] text-(--ui-text-quaternary) py-1', children: L.emptyActivity })
                : jsx('div', {
                    className: 'flex flex-col gap-1 max-h-40 overflow-y-auto',
                    children: snap.auditLog.map(item =>
                      jsxs('div', {
                        key: item.id,
                        className: 'flex items-center justify-between gap-2 text-[0.66rem]',
                        children: [
                          jsx('span', {
                            className: 'truncate font-mono text-(--ui-text-secondary)',
                            title: item.error || item.target,
                            children: `${item.ok ? '✓' : '✗'} ${item.action}: ${item.target}`
                          }),
                          jsx('span', {
                            className: 'shrink-0 text-(--ui-text-tertiary)',
                            children: `${item.durationMs}ms`
                          })
                        ]
                      })
                    )
                  })
            ]
          }),

          jsxs('div', {
            className: 'flex items-center justify-between pt-1.5 border-t',
            style: { borderColor: 'var(--ui-stroke-secondary)' },
            children: [
              jsx(Button, {
                size: 'xs',
                variant: 'secondary',
                onClick: () => onManualSync?.(true),
                children: L.syncNow
              }),
              jsx(Button, {
                size: 'xs',
                variant: 'secondary',
                onClick: () => onForceSelfUpdate?.(true),
                children: L.updatePlugin
              })
            ]
          })
        ]
      })
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Client Bridge',
  register(ctx) {
    const shellMgr = createShellManager()
    let cachedIdentity = null
    let disposed = false
    let syncDebounceTimer = null
    let regTimer = null
    let selfUpdating = false
    let lastUpdateCheckAt = 0

    const maybeSelfUpdate = async (serverSha, manual = false) => {
      if (disposed || selfUpdating) return
      const now = Date.now()
      if (!manual && now - lastUpdateCheckAt < 25000) return
      lastUpdateCheckAt = now

      if (!cachedIdentity) cachedIdentity = await detectLocalIdentity({ bgPtys: shellMgr.bgPtys })
      const localSha = staticMachineCache?.localSha || ''
      if (!manual && (!serverSha || !localSha || serverSha === localSha)) return
      if (!cachedIdentity.desktop_plugins_root) return

      selfUpdating = true
      try {
        const bundle = await ctx.rest('/desktop-plugin-bundle')
        if (!bundle?.ok || !bundle?.source || !bundle?.sha) return
        if (!manual && bundle.sha === localSha) return
        const computed = await sha256Short(bundle.source)
        if (computed && computed !== bundle.sha) return

        const d = window.hermesDesktop
        const selfPath = joinClientPath(cachedIdentity.isWin, cachedIdentity.desktop_plugins_root, PLUGIN_ID, 'plugin.js')
        const wr = await d.writeTextFile(selfPath, bundle.source)
        if (wr?.error) throw new Error(wr.error)
        if (staticMachineCache) staticMachineCache.localSha = bundle.sha
        uiState.pluginSha = bundle.sha
        emitUi()
        host.notify({ kind: 'info', message: L.autoUpdated(bundle.sha.slice(0, 8)) })
        await d.reconcileDesktopPlugins?.()
      } catch (err) {
        if (manual) host.notifyError?.(err, L.updateFailed)
      } finally {
        selfUpdating = false
      }
    }

    const handleRequest = async req => {
      if (!req || !req.req_id || handledReqIds.has(req.req_id)) return
      if (!cachedIdentity) cachedIdentity = await detectLocalIdentity({ bgPtys: shellMgr.bgPtys })
      if (req.target_client_id && req.target_client_id !== cachedIdentity.client_id) return

      rememberHandledReq(req.req_id)
      const started = performance.now()
      uiState.activeCount++
      emitUi()

      const targetDesc = String(
        req.params?.command || (req.params?.clipboard ? '[clipboard]' : '') || req.params?.path || req.params?.op || req.action || ''
      ).slice(0, 80)

      try {
        const result = await executeBridgeAction(ctx, shellMgr, req, cachedIdentity, () => scheduleSync(false))
        const durationMs = Math.round(performance.now() - started)
        recordAudit({
          id: req.req_id,
          time: Date.now(),
          action: req.action,
          target: targetDesc || 'ok',
          durationMs,
          ok: true
        })
        await ctx.rest('/respond', {
          method: 'POST',
          body: {
            req_id: req.req_id,
            client_id: cachedIdentity.client_id,
            ok: true,
            result
          }
        })
      } catch (err) {
        const durationMs = Math.round(performance.now() - started)
        const errMsg = String(err?.message || err || 'Unknown client error')
        recordAudit({
          id: req.req_id,
          time: Date.now(),
          action: req.action,
          target: targetDesc || 'error',
          durationMs,
          ok: false,
          error: errMsg
        })
        await ctx.rest('/respond', {
          method: 'POST',
          body: {
            req_id: req.req_id,
            client_id: cachedIdentity.client_id,
            ok: false,
            error: errMsg
          }
        })
      } finally {
        uiState.activeCount = Math.max(0, uiState.activeCount - 1)
        emitUi()
      }
    }

    const syncRegistration = async (rescanPlugins = false) => {
      if (disposed) return
      try {
        cachedIdentity = await detectLocalIdentity({ rescanPlugins, bgPtys: shellMgr.bgPtys })
        const res = await ctx.rest('/register', {
          method: 'POST',
          body: cachedIdentity
        })
        if (Array.isArray(res?.pending_requests)) {
          for (const req of res.pending_requests) {
            handleRequest(req)
          }
        }
        if (res?.desktop_plugin_sha) {
          maybeSelfUpdate(res.desktop_plugin_sha, false)
        }
      } catch {}
    }

    const scheduleSync = (rescanPlugins = false) => {
      if (disposed) return
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer)
      syncDebounceTimer = setTimeout(() => syncRegistration(rescanPlugins), 250)
    }

    let pollLoopActive = false
    let pollBackoffTimer = null

    const runPollLoop = async () => {
      if (disposed || pollLoopActive) return
      pollLoopActive = true
      try {
        while (!disposed) {
          if (!cachedIdentity?.client_id) {
            await new Promise(r => { pollBackoffTimer = setTimeout(r, 800) })
            continue
          }
          const waitSec = uiState.onBattery ? 25 : 20
          let nextDelayMs = 80
          try {
            const s = readHostSessions()
            const qs = new URLSearchParams({
              client_id: cachedIdentity.client_id,
              active_session_id: s.active_chat_session_id || '',
              focused_session_id: s.focused_session_id || '',
              mode: currentMode,
              wait: String(waitSec)
            })
            const res = await ctx.rest(`/poll?${qs.toString()}`, { timeoutMs: (waitSec + 10) * 1000 })
            const pending = Array.isArray(res?.pending_requests) ? res.pending_requests : []
            for (const req of pending) {
              handleRequest(req)
            }
            if (res?.desktop_plugin_sha) {
              maybeSelfUpdate(res.desktop_plugin_sha, false)
            }
            if (res?.long_poll) {
              nextDelayMs = 50
            } else {
              nextDelayMs = pending.length > 0 ? 100 : (uiState.onBattery ? 4000 : 1200)
            }
          } catch {
            nextDelayMs = uiState.onBattery ? 8000 : 3000
          }
          if (disposed) break
          await new Promise(r => { pollBackoffTimer = setTimeout(r, nextDelayMs) })
        }
      } finally {
        pollLoopActive = false
      }
    }

    const resetTimers = () => {
      if (regTimer) clearInterval(regTimer)
      if (disposed) return
      const regMs = uiState.onBattery ? 180000 : 90000
      regTimer = setInterval(() => syncRegistration(false), regMs)
      runPollLoop()
    }

    ctx.onEvent(EVENT_REQUEST, ({ payload }) => {
      const req = payload?.req_id ? payload : payload?.payload
      if (req?.req_id) handleRequest(req)
    })

    const unsubs = [
      subscribeAtom(host?.state?.focusedSessionId, () => scheduleSync(false)),
      subscribeAtom(host?.state?.focusedStoredSessionId, () => scheduleSync(false)),
      subscribeAtom(host?.state?.activeSessionId, () => scheduleSync(false))
    ].filter(Boolean)

    const d = window.hermesDesktop
    Promise.resolve(d?.getOnBattery?.())
      .then(onBat => {
        if (typeof onBat === 'boolean' && onBat !== uiState.onBattery) {
          uiState.onBattery = onBat
          emitUi()
          resetTimers()
        }
      })
      .catch(() => {})

    let unsubBattery = null
    let unsubResume = null
    try {
      unsubBattery = d?.onBatteryChanged?.(onBat => {
        uiState.onBattery = Boolean(onBat)
        emitUi()
        resetTimers()
      })
    } catch {}
    try {
      unsubResume = d?.onPowerResume?.(() => {
        syncRegistration(false)
      })
    } catch {}

    ctx.register({
      id: 'client-bridge-status',
      area: STATUSBAR_AREAS.right,
      order: 115,
      render: () =>
        jsx(StatusBarControl, {
          onManualSync: rescan => syncRegistration(Boolean(rescan)),
          onForceSelfUpdate: manual => maybeSelfUpdate('', Boolean(manual)),
          shellMgr
        })
    })

    syncRegistration(true)
    resetTimers()

    ctx.onDispose?.(() => {
      disposed = true
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer)
      if (pollBackoffTimer) clearTimeout(pollBackoffTimer)
      if (regTimer) clearInterval(regTimer)
      for (const u of unsubs) {
        try { u() } catch {}
      }
      try { unsubBattery?.() } catch {}
      try { unsubResume?.() } catch {}
      shellMgr.disposeAll()
    })
  }
}
