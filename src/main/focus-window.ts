import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'path'
import { execFile } from 'child_process'
import { is } from '@electron-toolkit/utils'
import type { IpcMain } from 'electron'
import { showWindowVisible } from './window-utils'
import { randomUUID } from 'crypto'
import { appendCheckIn, appendOperation, getAppData, loadCheckIns, notifyAllWindows, setAppDataKey } from './store'
import { onFocusStart, onFocusStop } from './focus-blocker'
import { addGameTokens } from './game-gate'
import { STANDALONE_PROJECT_ID } from '../shared/constants'
import { FOCUS_DOCK_HEIGHT, FOCUS_DOCK_WIDTH, isFocusDock } from '../shared/types'
import type { FocusDock } from '../shared/types'

let focusWindow: BrowserWindow | null = null
let focusMenuWindow: BrowserWindow | null = null
let checkInWindow: BrowserWindow | null = null
let operationLogWindow: BrowserWindow | null = null
let checkInTimeout: ReturnType<typeof setTimeout> | null = null
let countdownInterval: ReturnType<typeof setInterval> | null = null
let checkInDeadline: number = 0
let lastCheckInAt: number = 0
let focusStartedAt: number = 0
let focusTaskInfo: { projectId?: string; projectName?: string; taskTitle?: string } = {}

const CHECK_IN_INTERVAL_MS = 15 * 60 * 1000

export function getFocusWindow(): BrowserWindow | null {
  return focusWindow
}

function startCheckInTimer(): void {
  clearCheckInTimer()
  lastCheckInAt = Date.now()
  checkInDeadline = Date.now() + CHECK_IN_INTERVAL_MS

  // Send countdown updates to focus window every second
  countdownInterval = setInterval(() => {
    if (focusWindow && !focusWindow.isDestroyed()) {
      const remaining = Math.max(0, checkInDeadline - Date.now())
      focusWindow.webContents.send('checkin-countdown', remaining)
    }
  }, 1000)

  checkInTimeout = setTimeout(() => {
    clearCountdownInterval()
    if (focusWindow && !focusWindow.isDestroyed()) {
      focusWindow.webContents.send('checkin-countdown', 0)
    }
    showCheckInPopup()
  }, CHECK_IN_INTERVAL_MS)
}

function clearCountdownInterval(): void {
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
}

function clearCheckInTimer(): void {
  if (checkInTimeout) {
    clearTimeout(checkInTimeout)
    checkInTimeout = null
  }
  clearCountdownInterval()
}

function playCheckInSound(): void {
  // Play macOS system notification sound
  execFile('afplay', ['/System/Library/Sounds/Tink.aiff'])
}

const CHECKIN_SHORTCUT_KEYS = ['1', '2', '3'] as const
const CHECKIN_RESPONSES: Record<string, 'yes' | 'a_little' | 'no'> = {
  '1': 'yes',
  '2': 'a_little',
  '3': 'no'
}

function registerCheckInShortcuts(): void {
  for (const key of CHECKIN_SHORTCUT_KEYS) {
    globalShortcut.register(key, () => {
      if (!checkInWindow || checkInWindow.isDestroyed()) return
      checkInWindow.webContents.send('checkin-respond', CHECKIN_RESPONSES[key])
    })
  }
}

function unregisterCheckInShortcuts(): void {
  for (const key of CHECKIN_SHORTCUT_KEYS) {
    globalShortcut.unregister(key)
  }
}

function showCheckInPopup(): void {
  if (checkInWindow && !checkInWindow.isDestroyed()) return
  if (!focusWindow || focusWindow.isDestroyed()) return

  playCheckInSound()

  const focusBounds = focusWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: focusBounds.x, y: focusBounds.y })

  const popupWidth = 340
  const popupHeight = 200

  // Position below the focus bar, right-aligned with it
  const x = Math.min(
    focusBounds.x + focusBounds.width - popupWidth,
    display.workArea.x + display.workArea.width - popupWidth
  )
  const y = focusBounds.y + focusBounds.height + 8

  checkInWindow = new BrowserWindow({
    width: popupWidth,
    height: popupHeight,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  checkInWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  checkInWindow.setAlwaysOnTop(true, 'screen-saver')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    checkInWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#checkin')
  } else {
    checkInWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'checkin' })
  }

  checkInWindow.on('closed', () => {
    unregisterCheckInShortcuts()
    checkInWindow = null
  })

  registerCheckInShortcuts()
}

function closeCheckInPopup(): void {
  unregisterCheckInShortcuts()
  if (checkInWindow && !checkInWindow.isDestroyed()) {
    checkInWindow.close()
    checkInWindow = null
  }
}

function resolveFocusTask(): { projectId?: string; projectName?: string; taskTitle?: string } {
  const { config, projects, quickTasks } = getAppData()
  const pid = config.focusProjectId
  const tid = config.focusTaskId
  if (!pid || !tid) return {}

  if (pid === STANDALONE_PROJECT_ID) {
    const qt = (quickTasks ?? []).find((t) => t.id === tid)
    if (qt?.projectId) {
      const project = projects.find((p) => p.id === qt.projectId)
      return { projectId: qt.projectId, projectName: project?.name, taskTitle: qt?.title }
    }
    return { taskTitle: qt?.title }
  }

  const project = projects.find((p) => p.id === pid)
  const task = project?.tasks.find((t) => t.id === tid)
  return { projectId: pid, projectName: project?.name, taskTitle: task?.title }
}

/**
 * Auto-stop focus when the focused task is completed from outside the focus window.
 * Saves any unsaved time (since last check-in) as a check-in without prompting.
 */
export function stopFocusForCompletedTask(taskId: string): void {
  const { config } = getAppData()
  if (!config.focusTaskId || config.focusTaskId !== taskId) return
  if (!focusWindow || focusWindow.isDestroyed()) return

  // Save unsaved time as check-in (no prompt)
  if (lastCheckInAt > 0 && config.focusProjectId) {
    const unsavedMin = Math.floor((Date.now() - lastCheckInAt) / 60000)
    if (unsavedMin >= 1) {
      appendCheckIn({
        id: randomUUID().slice(0, 21),
        projectId: config.focusProjectId,
        taskId,
        timestamp: new Date().toISOString(),
        response: 'yes',
        minutes: unsavedMin
      })
    }
  }

  exitFocusMode()
}

let _getMainWindow: (() => BrowserWindow | null) | null = null

const FOCUS_FREE_WIDTH = 520

/** Default spot of the free-floating bar: top-right of the primary display's work area. */
function freeFocusPosition(): { x: number; y: number } {
  const { x, y, width } = screen.getPrimaryDisplay().workArea
  return { x: x + width - FOCUS_FREE_WIDTH - 16, y: y + 12 }
}

/** True when enough of the rect lies on a connected display to be seen and grabbed. */
function isOnScreen(rect: Electron.Rectangle): boolean {
  return screen.getAllDisplays().some(({ bounds: d }) => {
    const w = Math.min(rect.x + rect.width, d.x + d.width) - Math.max(rect.x, d.x)
    const h = Math.min(rect.y + rect.height, d.y + d.height) - Math.max(rect.y, d.y)
    return w >= 40 && h >= 10
  })
}

/**
 * Bounds of the docked bar: inside the menu-bar strip, which a fullscreen app leaves
 * black next to the notch — so the bar covers nothing there. Anchored so the window
 * grows away from the notch / screen corner when a panel widens it.
 */
function dockedFocusBounds(dock: FocusDock, width: number, height: number): Electron.Rectangle {
  // A spot the user dragged the bar to wins over the preset - but only while its display is
  // connected (lid closed, monitor unplugged); the spot is kept for when the display returns.
  const pos = getAppData().config.focusDockPos
  if (pos && isOnScreen({ ...pos, width: FOCUS_DOCK_WIDTH, height: FOCUS_DOCK_HEIGHT })) {
    const { bounds: d } = screen.getDisplayMatching({ ...pos, width: FOCUS_DOCK_WIDTH, height: FOCUS_DOCK_HEIGHT })
    // A panel widens the window: keep it inside the display.
    const x = Math.max(d.x, Math.min(pos.x, d.x + d.width - width))
    return { x, y: pos.y, width, height }
  }
  // Only the built-in display has a notch; corners go to the display that owns the menu bar.
  // With the lid closed there is no internal display, so everything lands on the primary one.
  const internal = screen.getAllDisplays().find((d) => d.internal)
  const byNotch = dock === 'notch-left' || dock === 'notch-right'
  const display = (byNotch && internal) || screen.getPrimaryDisplay()
  const { x: dx, y: dy, width: dw } = display.bounds
  // Electron exposes no notch geometry; the notch is ~12.5% of the built-in display's width.
  // Tuck the black bar ~18px under it so the two always touch (the bar pads its content for this).
  const notchHalf = display.internal ? Math.round(dw * 0.0625) - 18 : 0
  const center = dx + dw / 2
  const x =
    dock === 'top-left' ? dx
      : dock === 'top-right' ? dx + dw - width
        : dock === 'notch-left' ? center - notchHalf - width
          : center + notchHalf
  return { x: Math.round(x), y: dy, width, height }
}

function placeFocusWindow(width: number, height: number): void {
  if (!focusWindow || focusWindow.isDestroyed()) return
  const dock = getAppData().config.focusDock
  focusWindow.setMinimumSize(width, height)
  if (dock) {
    focusWindow.setBounds(dockedFocusBounds(dock, width, height))
  } else {
    focusWindow.setSize(width, height)
    // Free bar left on a display that is gone: bring it back to the default spot.
    if (!isOnScreen(focusWindow.getBounds())) {
      const { x, y } = freeFocusPosition()
      focusWindow.setPosition(x, y)
    }
  }
  // 'floating' is below the menu bar's level, so a docked bar would hide behind it.
  focusWindow.setAlwaysOnTop(true, dock ? 'status' : 'floating')
  // The native shadow outlines the whole window, which breaks the "part of the notch" look.
  focusWindow.setHasShadow(!dock)
}

/** Re-apply the current size's placement, e.g. after the set of displays changed. */
function replaceFocusWindow(): void {
  if (!focusWindow || focusWindow.isDestroyed()) return
  const { width, height } = focusWindow.getBounds()
  placeFocusWindow(width, height)
}

let dockDragTimer: ReturnType<typeof setInterval> | null = null
/** A plain click on the bar must not turn the preset into a dragged position. */
let dockDragMoved = false

/**
 * Drag of the docked bar, driven from main: a native window drag cannot enter the menu-bar
 * strip. The bar follows the cursor horizontally and stays glued to the top edge of whatever
 * display the cursor is on.
 */
function startDockDrag(): void {
  stopDockDrag(false)
  if (!focusWindow || focusWindow.isDestroyed() || !getAppData().config.focusDock) return
  const start = focusWindow.getBounds()
  // Only the collapsed bar is draggable; with a panel open the window is wider than the bar.
  if (start.width !== FOCUS_DOCK_WIDTH) return
  const grabOffset = screen.getCursorScreenPoint().x - start.x
  dockDragMoved = false
  dockDragTimer = setInterval(() => {
    if (!focusWindow || focusWindow.isDestroyed()) return stopDockDrag(false)
    const cursor = screen.getCursorScreenPoint()
    const { bounds: d } = screen.getDisplayNearestPoint(cursor)
    const x = Math.max(d.x, Math.min(cursor.x - grabOffset, d.x + d.width - start.width))
    if (x === start.x && d.y === start.y && !dockDragMoved) return
    dockDragMoved = true
    focusWindow.setBounds({ x, y: d.y, width: start.width, height: start.height })
  }, 16)
}

function stopDockDrag(save: boolean): void {
  if (!dockDragTimer) return
  clearInterval(dockDragTimer)
  dockDragTimer = null
  if (!save || !dockDragMoved || !focusWindow || focusWindow.isDestroyed()) return
  const { x, y } = focusWindow.getBounds()
  setAppDataKey('config', { ...getAppData().config, focusDockPos: { x, y } })
  notifyAllWindows()
}

export function enterFocusMode(options?: { resumeStartedAt?: number }): { error: string } | undefined {
  if (focusWindow && !focusWindow.isDestroyed()) return { error: 'already_in_focus' }

  const mainWin = _getMainWindow?.() ?? null
  if (!mainWin) return { error: 'no_main_window' }

  // Hide main window
  mainWin.hide()

  // Free bar always opens on the primary display; a docked one goes straight to its strip.
  const dock = getAppData().config.focusDock
  focusWindow = new BrowserWindow({
    ...(dock
      ? dockedFocusBounds(dock, FOCUS_DOCK_WIDTH, FOCUS_DOCK_HEIGHT)
      : { width: FOCUS_FREE_WIDTH, height: 64, ...freeFocusPosition() }),
    // Without this macOS clamps the window below the menu bar (docked mode sits in it).
    enableLargerThanScreen: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: !dock,
    // Native corner rounding would turn the docked bar into a pill; the bar rounds itself in CSS.
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Keep on all Spaces but allow moving between monitors
  focusWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  focusWindow.setAlwaysOnTop(true, dock ? 'status' : 'floating')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    focusWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#focus')
  } else {
    focusWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'focus' })
  }

  focusWindow.on('closed', () => {
    stopDockDrag(false)
    focusWindow = null
  })

  const isResume = typeof options?.resumeStartedAt === 'number'
  focusStartedAt = isResume ? options!.resumeStartedAt! : Date.now()
  focusTaskInfo = resolveFocusTask()

  // Persist startedAt so a restart can resume the same session
  const cfg = getAppData().config
  if (cfg.focusStartedAt !== focusStartedAt) {
    setAppDataKey('config', { ...cfg, focusStartedAt })
  }

  appendOperation({ type: isResume ? 'focus_resumed' : 'focus_started', ...focusTaskInfo })

  // Activate distraction blocking for this task (saved selection, or default meta on first launch).
  onFocusStart(getAppData().config.focusTaskId, focusTaskInfo.taskTitle)

  startCheckInTimer()
  return undefined
}

export function exitFocusMode(): { error: string } | undefined {
  if (!focusWindow || focusWindow.isDestroyed()) return { error: 'not_in_focus' }

  const mainWin = _getMainWindow?.() ?? null

  // Log focus end with reported (check-in) time
  const reportedMinutes = focusStartedAt
    ? loadCheckIns()
        .filter((c) => new Date(c.timestamp).getTime() >= focusStartedAt)
        .reduce((sum, c) => sum + (c.minutes ?? (c.response === 'yes' ? 15 : c.response === 'a_little' ? 7 : 0)), 0)
    : 0
  appendOperation({ type: 'focus_ended', ...focusTaskInfo, details: `${reportedMinutes}min` })
  // Earn game tokens from the reported (check-in) minutes, not wall-clock time —
  // a focus left running for hours must not credit hours of play.
  addGameTokens(reportedMinutes * 60)
  focusStartedAt = 0
  focusTaskInfo = {}

  // Clear focus state in store before showing main window
  const { config } = getAppData()
  setAppDataKey('config', { ...config, focusProjectId: null, focusTaskId: null, focusStartedAt: null })

  clearCheckInTimer()
  closeCheckInPopup()
  onFocusStop()

  if (focusMenuWindow && !focusMenuWindow.isDestroyed()) {
    focusMenuWindow.close()
    focusMenuWindow = null
  }

  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.close()
    focusWindow = null
  }

  if (mainWin) {
    // Tell main window to reload data
    mainWin.webContents.send('reload-data')
    showWindowVisible(mainWin)
  }
  return undefined
}

/**
 * Heartbeat — confirms user is still working.
 * Saves a check-in for accumulated time, resets the 15-min timer,
 * and closes the check-in popup if it's showing.
 */
export function heartbeatFocus(): { error: string } | { saved: boolean; minutes: number } {
  if (!focusWindow || focusWindow.isDestroyed()) return { error: 'not_in_focus' }

  const { config } = getAppData()
  const projectId = config.focusProjectId
  const taskId = config.focusTaskId
  if (!projectId || !taskId) return { error: 'no_focus_task' }

  let savedMinutes = 0
  if (lastCheckInAt > 0) {
    const unsavedMin = Math.floor((Date.now() - lastCheckInAt) / 60000)
    if (unsavedMin >= 1) {
      appendCheckIn({
        id: randomUUID().slice(0, 21),
        projectId,
        taskId,
        timestamp: new Date().toISOString(),
        response: 'yes',
        minutes: unsavedMin
      })
      savedMinutes = unsavedMin
    }
  }

  closeCheckInPopup()
  startCheckInTimer()

  return { saved: savedMinutes > 0, minutes: savedMinutes }
}

export function getFocusStatus(): {
  active: boolean
  projectId?: string
  taskId?: string
  projectName?: string
  taskTitle?: string
  startedAt?: number
  elapsedMs?: number
} {
  const { config } = getAppData()
  const active = !!(focusWindow && !focusWindow.isDestroyed())
  if (!active) return { active: false }
  return {
    active: true,
    projectId: config.focusProjectId ?? undefined,
    taskId: config.focusTaskId ?? undefined,
    projectName: focusTaskInfo.projectName,
    taskTitle: focusTaskInfo.taskTitle,
    startedAt: focusStartedAt || undefined,
    elapsedMs: focusStartedAt ? Date.now() - focusStartedAt : undefined,
  }
}

export function registerFocusHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): void {
  _getMainWindow = getMainWindow

  ipcMain.handle('enter-focus-mode', () => enterFocusMode())

  // Set focus target then enter — used by quick-add's "add & focus" (project id is
  // STANDALONE_PROJECT_ID for quick tasks). Same shape as nudge-start-focus.
  ipcMain.handle('focus-on-task', (_event, projectId: string, taskId: string) => {
    if (focusWindow && !focusWindow.isDestroyed()) return { error: 'already_in_focus' }
    if (typeof projectId !== 'string' || typeof taskId !== 'string') return { error: 'invalid_args' }
    const { config } = getAppData()
    setAppDataKey('config', { ...config, focusProjectId: projectId, focusTaskId: taskId })
    const result = enterFocusMode()
    if (result?.error) {
      // rollback focus target on failure
      setAppDataKey('config', { ...getAppData().config, focusProjectId: null, focusTaskId: null })
    }
    return result
  })

  ipcMain.handle('exit-focus-mode', () => exitFocusMode())

  ipcMain.handle('get-focus-unsaved-ms', () => {
    if (!lastCheckInAt) return 0
    return Date.now() - lastCheckInAt
  })

  ipcMain.handle('dismiss-checkin', () => {
    closeCheckInPopup()
    // Start next timer only after user responds
    if (focusWindow && !focusWindow.isDestroyed()) {
      startCheckInTimer()
    }
  })

  ipcMain.handle('switch-focus-task', (_event, projectId: string, taskId: string) => {
    if (!focusWindow || focusWindow.isDestroyed()) return

    const { config } = getAppData()
    setAppDataKey('config', { ...config, focusProjectId: projectId, focusTaskId: taskId })
    focusTaskInfo = resolveFocusTask()

    // Re-activate blocking for the new task (its saved selection, or default).
    onFocusStart(taskId, focusTaskInfo.taskTitle)

    // Reset check-in timer for the new task
    startCheckInTimer()

    // Notify all windows (focus + main) to reload data
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('reload-data')
      }
    }
  })

  ipcMain.handle('resize-focus-window', (_event, width: number, height: number) => {
    placeFocusWindow(width, height)
  })

  ipcMain.handle('focus-dock-drag', (_event, active: unknown) => {
    if (active === true) startDockDrag()
    else stopDockDrag(true)
  })

  ipcMain.handle('set-focus-dock', (_event, dock: unknown) => {
    const focusDock = isFocusDock(dock) ? dock : undefined
    // Picking a preset drops the dragged position.
    setAppDataKey('config', { ...getAppData().config, focusDock, focusDockPos: undefined })
    // Undocking: leave the menu-bar strip, where a 'floating' window is invisible.
    if (!focusDock && focusWindow && !focusWindow.isDestroyed()) {
      const { x, y } = freeFocusPosition()
      focusWindow.setPosition(x, y)
    }
    // The focus window reloads config and re-sends its size, which applies the new dock;
    // re-picking the current preset changes nothing there, so place it here too.
    replaceFocusWindow()
    notifyAllWindows()
  })

  // Monitor plugged/unplugged, lid closed, resolution changed: never leave the bar off-screen.
  screen.on('display-added', replaceFocusWindow)
  screen.on('display-removed', replaceFocusWindow)
  screen.on('display-metrics-changed', replaceFocusWindow)

  let pendingMenuItems: { id: string; label: string; type?: 'separator' }[] = []

  ipcMain.handle('show-focus-context-menu', (_event, items: { id: string; label: string; type?: 'separator' }[], clickX: number, clickY: number) => {
    if (!focusWindow || focusWindow.isDestroyed()) return

    // Toggle — close if already open
    if (focusMenuWindow && !focusMenuWindow.isDestroyed()) {
      focusMenuWindow.close()
      focusMenuWindow = null
      return
    }

    pendingMenuItems = items

    const focusBounds = focusWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: focusBounds.x, y: focusBounds.y })
    const workArea = display.workArea

    const popupWidth = 200
    const itemCount = items.filter((i) => i.type !== 'separator').length
    const sepCount = items.filter((i) => i.type === 'separator').length
    const popupHeight = itemCount * 30 + sepCount * 9 + 12

    // Position at click coords (translated to screen), clamped to screen edges
    const rawX = focusBounds.x + clickX
    const rawY = focusBounds.y + clickY
    const x = Math.min(rawX, workArea.x + workArea.width - popupWidth)
    const y = Math.min(rawY, workArea.y + workArea.height - popupHeight)

    focusMenuWindow = new BrowserWindow({
      width: popupWidth,
      height: popupHeight,
      x,
      y,
      frame: false,
      transparent: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      roundedCorners: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    focusMenuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    focusMenuWindow.setAlwaysOnTop(true, 'screen-saver')

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      focusMenuWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#focus-menu')
    } else {
      focusMenuWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'focus-menu' })
    }

    focusMenuWindow.on('blur', () => {
      if (focusMenuWindow && !focusMenuWindow.isDestroyed()) {
        focusMenuWindow.close()
      }
      focusMenuWindow = null
    })

    focusMenuWindow.on('closed', () => {
      focusMenuWindow = null
    })
  })

  ipcMain.handle('get-focus-menu-items', () => {
    return pendingMenuItems
  })

  ipcMain.handle('focus-menu-click', (_event, actionId: string) => {
    if (focusMenuWindow && !focusMenuWindow.isDestroyed()) {
      focusMenuWindow.close()
      focusMenuWindow = null
    }
    if (focusWindow && !focusWindow.isDestroyed()) {
      focusWindow.webContents.send('focus-menu-action', actionId)
    }
  })

  ipcMain.handle('show-project-in-main', (_event, projectId: string) => {
    const mainWin = getMainWindow()
    if (!mainWin) return
    mainWin.webContents.send('navigate-to-project', projectId)
    showWindowVisible(mainWin)
  })

  ipcMain.handle('open-operation-log-window', (_event, filter?: string) => {
    if (operationLogWindow && !operationLogWindow.isDestroyed()) {
      operationLogWindow.close()
      operationLogWindow = null
    }

    const hash = filter
      ? `operation-log?filter=${encodeURIComponent(filter)}`
      : 'operation-log'

    operationLogWindow = new BrowserWindow({
      width: 520,
      height: 600,
      resizable: true,
      title: 'Activity Log',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      operationLogWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#' + hash)
    } else {
      operationLogWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    }

    operationLogWindow.on('closed', () => {
      operationLogWindow = null
    })
  })
}
