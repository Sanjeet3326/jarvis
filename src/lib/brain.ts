import * as bridge from './bridge'
import type { AskHandlers } from './bridge'
import type { Blade, Panel } from '../store'

export type { AskHandlers }
export type { ConnectionState } from './bridge'

/**
 * The brain: the local bridge (bridge/server.mjs), a Node process running the
 * Claude Agent SDK on your Claude login. Conversation state lives in the
 * bridge session, so nothing is threaded through here.
 */
export async function ask(
  prompt: string,
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  return bridge.ask(prompt, handlers)
}

export async function warm(): Promise<void> {
  await bridge.warmBridge()
}

/** The bridge reports its server list twice — from config on connect, then
 *  with live status once the agent boots — so the HUD subscribes. */
export function watchServers(fn: (servers: string[]) => void): void {
  bridge.watchServers(fn)
}

/** HUD panels are pushed mid-turn by the `display` tool, not returned by ask(). */
export function watchPanels(fn: (panel: Panel) => void): void {
  bridge.watchPanels(fn)
}

/** Blades — the big surface — arrive the same way. */
export function watchBlades(fn: (blade: Blade) => void): void {
  bridge.watchBlades(fn)
}

/** Redressing the interface (theme, reactor, orbits) via the ui_* tools. */
export function watchUi(fn: (op: string, args: any) => void): void {
  bridge.watchUi(fn)
}

/**
 * The one thing the bridge asks US for: a camera frame. The hardware is in the
 * page and the model is in the bridge, so this answers a request.
 */
export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  bridge.watchCapture(fn)
}

/** Barge-in: interrupts the agent and settles the outstanding ask(). */
export function cancel(): void {
  bridge.cancel()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** Whether the bridge socket — which is the session — is up. */
export function isConnected(): boolean {
  return bridge.isConnected()
}

/**
 * Connection state, for the UI. The socket is the conversation, so a drop
 * wipes what the agent remembers while the transcript still shows it.
 */
export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  bridge.watchConnection(fn)
}

/** Labels for the HUD's SYSTEMS rail. */
export function connectedLabels(): string[] {
  return bridge.bridgeServers()
}
