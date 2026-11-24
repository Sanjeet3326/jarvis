/**
 * In the desktop app, the window is only there while you are talking to it.
 *
 * Saji runs all the time, hidden in the tray, listening for "Hey Saji". When
 * it wakes the window comes up on top (without taking the keyboard from what
 * you were doing); when the conversation has gone quiet it goes away again.
 * In a normal browser tab none of this exists and nothing happens.
 */
import { useStore, type Phase } from '../store'

type Desktop = { show: () => void; hide: () => void }
const desktop = (window as unknown as { sajiDesktop?: Desktop }).sajiDesktop

/** Phases that mean a conversation is happening. */
const ACTIVE: Phase[] = ['waking', 'listening', 'thinking', 'tooling', 'speaking']
/** How long after going quiet before the window hides. */
const HIDE_AFTER_MS = 5000

if (desktop) {
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Until Saji has been dormant once, only a real question brings the window
   * up — so the start-up greeting and its listening window stay in the tray.
   */
  let settled = false

  // Asked on every phase of a conversation, not just the first: you may have
  // hidden it by hand (Ctrl+Space) mid-way. Showing a shown window is a no-op.
  const show = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    desktop.show()
  }

  useStore.subscribe((s, prev) => {
    if (s.phase === prev.phase) return
    if (s.phase === 'dormant') {
      settled = true
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        hideTimer = null
        // Clicked into it — you are using it, so it stays until you close it.
        if (document.hasFocus()) return
        desktop.hide()
      }, HIDE_AFTER_MS)
      return
    }
    if (!ACTIVE.includes(s.phase)) return
    if (settled || s.phase === 'thinking' || s.phase === 'tooling') show()
  })
}
