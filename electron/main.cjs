/**
 * JARVIS as a desktop app.
 *
 * The same two halves `npm start` runs — the bridge (brain) and the Vite
 * server (face) — started as children of an Electron window instead of a
 * terminal, so JARVIS opens from a desktop icon, lives in the system tray, can
 * start with Windows and keeps listening while its window is hidden.
 *
 *   npm run desktop                 open it
 *   npm run desktop -- --writes     let it take real actions on this PC
 *   ... --hidden                    start in the tray (used by "Start with Windows")
 *
 * Everything the bridge and the face print goes to logs/desktop.log.
 */

const { app, BrowserWindow, Tray, Menu, globalShortcut, session, dialog, nativeImage, shell, ipcMain } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..')
/** Inside the 5173-5199 range the bridge already trusts, and away from the
 *  5173 that `npm start` uses, so the two never fight over a port. */
const PORT = 5190
const URL = `http://localhost:${PORT}/`
const HOTKEYS = ['Control+Space', 'Control+Alt+J']

const argv = process.argv.slice(1)
/** Always on, out of sight: the window only comes up when you say "Hey Saji"
 *  (or use Ctrl+Space / the tray). --show opens it straight away instead. */
const startHidden = !argv.includes('--show')
const writes = argv.includes('--writes') || process.env.JARVIS_ALLOW_WRITES === '1'

// Audio and speech without a click first: this is a voice assistant on your own
// machine, not a web page you stumbled onto.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => show())
}

// ---------------------------------------------------------------- logging

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
const logFile = fs.createWriteStream(path.join(ROOT, 'logs', 'desktop.log'), { flags: 'a' })
function log(tag, data) {
  const lines = data.toString().split(/\r?\n/).filter(Boolean)
  for (const l of lines) logFile.write(`${new Date().toLocaleTimeString('en-GB')} ${tag} ${l}\n`)
}
log('app', `--- SAJI desktop starting (writes ${writes ? 'ON' : 'off'}) ---`)

// ---------------------------------------------------------------- children

const children = []
let quitting = false

/** The system Node if there is one, otherwise Electron's own runtime as Node. */
function nodeCommand() {
  try {
    execFileSync('node', ['-v'], { stdio: 'ignore', windowsHide: true })
    return { cmd: 'node', env: {} }
  } catch {
    return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
}

function run(tag, args, env) {
  const node = nodeCommand()
  const child = spawn(node.cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...node.env, ...env },
    windowsHide: true,
  })
  child.stdout.on('data', (d) => log(tag, d))
  child.stderr.on('data', (d) => log(tag, d))
  child.on('exit', (code) => {
    log(tag, `exited (${code})`)
    if (quitting) return
    dialog.showErrorBox(
      'SAJI stopped',
      `The ${tag} stopped unexpectedly (code ${code}).\n\n` +
        'If `npm start` is running in a terminal, close it first — both use the same port.\n\n' +
        `Details: ${path.join(ROOT, 'logs', 'desktop.log')}`,
    )
    quit()
  })
  children.push(child)
}

function killChildren() {
  for (const c of children) {
    if (c.exitCode !== null) continue
    try {
      // The whole tree: Vite has helpers of its own.
      execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      try { c.kill() } catch { /* gone */ }
    }
  }
}

function waitForFace(timeoutMs = 60000) {
  const until = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(URL, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > until) reject(new Error('the interface did not start'))
        else setTimeout(poll, 300)
      })
      req.setTimeout(2000, () => req.destroy())
    }
    poll()
  })
}

// ---------------------------------------------------------------- window

let win = null
let tray = null
let hintedTray = false

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'S.A.J.I.',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Lets the page ask to appear on "Hey Saji" and hide when quiet.
      preload: path.join(__dirname, 'preload.cjs'),
      // Keep listening for "Hey Saji" while minimised or in the tray. Without
      // this Chromium throttles a hidden page and the wake word goes deaf.
      backgroundThrottling: false,
    },
  })

  win.on('close', (e) => {
    if (quitting) return
    // Closing hides to the tray; Saji keeps listening.
    e.preventDefault()
    win.setAlwaysOnTop(false)
    win.hide()
    if (!hintedTray && tray) {
      hintedTray = true
      tray.displayBalloon({
        iconType: 'info',
        title: 'SAJI is still listening',
        content: 'Say "Hey Saji", press Ctrl+Space, or use the tray icon. Right-click it to quit.',
      })
    }
  })

  // Links JARVIS shows open in your normal browser, not inside this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL)) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })

  win.webContents.on('did-finish-load', () => void autoInitialise())
  win.webContents.on('console-message', (e) => {
    const m = e.message ?? ''
    if (e.level === 'error' || e.level === 3 || /\[jarvis\]/.test(m)) log('page', m)
  })
  win.webContents.on('render-process-gone', (_e, d) => log('page', `renderer gone: ${d.reason}`))

  void win.loadURL(URL)
  if (!startHidden) win.once('ready-to-show', () => show())
}

/**
 * Press INITIALISE for you. A browser needs that click before it may make a
 * sound; the app window is allowed to, so JARVIS powers up and greets you as
 * soon as it opens — including at Windows start-up, with nobody at the screen.
 */
async function autoInitialise() {
  for (let i = 0; i < 50; i++) {
    try {
      const clicked = await win.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.ignition'); if (b) { b.click(); return true } return false })()`,
        true,
      )
      if (clicked) return log('app', 'initialised')
    } catch { /* page still loading */ }
    await new Promise((r) => setTimeout(r, 200))
  }
}

function show() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(false)
  win.show()
  win.focus()
}

/**
 * Up on "Hey Saji": in front of everything, but without taking the keyboard
 * from whatever you were typing in.
 */
function pop() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(true, 'floating')
  if (!win.isVisible()) win.showInactive()
  win.moveTop()
}

/** Away again once the conversation is over — unless you are using it. */
function unpop() {
  if (!win || !win.isVisible() || win.isFocused()) return
  win.setAlwaysOnTop(false)
  win.hide()
}

ipcMain.on('saji:show', (e) => {
  if (e.sender === win?.webContents) pop()
})
ipcMain.on('saji:hide', (e) => {
  if (e.sender === win?.webContents) unpop()
})

function toggle() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) win.hide()
  else show()
}

// ---------------------------------------------------------------- tray

const AUTOSTART = () => ({
  path: process.execPath,
  args: app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'],
})

function startsWithWindows() {
  return app.getLoginItemSettings(AUTOSTART()).openAtLogin
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')))
  tray.setToolTip('SAJI — say "Hey Saji"')
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Show SAJI', click: show },
      { label: `Shortcut: ${hotkey ?? 'none'}`, enabled: false },
      { label: 'PC controls: on (risky ones ask first)', enabled: false },
      { label: writes ? 'Shell and file writes: ON' : 'Shell and file writes: off', enabled: false },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startsWithWindows(),
        click: (item) => {
          app.setLoginItemSettings({ ...AUTOSTART(), openAtLogin: item.checked })
          tray.setContextMenu(menu())
        },
      },
      { label: 'Open log', click: () => void shell.openPath(path.join(ROOT, 'logs', 'desktop.log')) },
      { label: 'Reload', click: () => win?.reload() },
      { type: 'separator' },
      { label: 'Quit SAJI', click: quit },
    ])
  trayMenu = menu
  tray.setContextMenu(menu())
  tray.on('click', toggle)
}
let trayMenu = null

let hotkey = null
function registerHotkey() {
  for (const k of HOTKEYS) {
    try {
      if (globalShortcut.register(k, toggle)) {
        hotkey = k.replace('Control', 'Ctrl')
        return log('app', `shortcut ${hotkey}`)
      }
    } catch { /* taken */ }
  }
  log('app', 'no global shortcut available')
}

function quit() {
  quitting = true
  globalShortcut.unregisterAll()
  killChildren()
  app.quit()
}

// ---------------------------------------------------------------- start

app.whenReady().then(async () => {
  app.setAppUserModelId('jarvis.desktop')

  // Microphone and camera for our own page only.
  const ours = (u) => typeof u === 'string' && u.startsWith(`http://localhost:${PORT}`)
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(ours(details?.requestingUrl ?? wc.getURL()) && ['media', 'clipboard-sanitized-write', 'notifications', 'speaker-selection'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
    ours(origin) && ['media', 'clipboard-sanitized-write', 'notifications', 'speaker-selection'].includes(permission),
  )

  registerHotkey()
  buildTray()

  run('bridge', ['bridge/server.mjs'], writes ? { JARVIS_ALLOW_WRITES: '1' } : {})
  run('face', ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], { PORT: String(PORT) })

  try {
    await waitForFace()
  } catch (err) {
    dialog.showErrorBox('SAJI could not start', `${err.message}.\n\nSee ${path.join(ROOT, 'logs', 'desktop.log')}`)
    return quit()
  }
  createWindow()

  // Always on means starting with Windows. Done once, on the first run; the
  // tray's "Start with Windows" turns it off for good.
  const marker = path.join(app.getPath('userData'), 'autostart-set')
  if (!fs.existsSync(marker)) {
    app.setLoginItemSettings({ ...AUTOSTART(), openAtLogin: true })
    fs.writeFileSync(marker, new Date().toISOString())
    log('app', 'set to start with Windows')
    if (tray && trayMenu) tray.setContextMenu(trayMenu())
  }

  if (startHidden && !argv.includes('--quiet')) {
    tray?.displayBalloon({
      iconType: 'info',
      title: 'Saji is on',
      content: 'Say "Hey Saji" whenever you need me. Ctrl+Space opens the window.',
    })
  }
})

// Hidden in the tray is still running.
app.on('window-all-closed', () => {})
app.on('before-quit', () => {
  quitting = true
  killChildren()
})
