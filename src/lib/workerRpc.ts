/**
 * A request/response channel to a Web Worker, for the models that would
 * otherwise run on the page's main thread.
 *
 * Why. The voice lock and the wake word run ONNX models. On the main thread
 * every run blocks it: measured, one voice check on 3s of speech froze the
 * screen for ~0.5s and on 6s for ~1.1s, and the lock checks every utterance it
 * hears, background voices included. In a worker the run takes as long, but the
 * animation and the HUD keep drawing while it does.
 *
 * Messages carry an `id`; anything a worker posts without one is an event
 * (download progress) and goes to `onEvent`.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export type Rpc = {
  call<T>(op: string, args?: Record<string, unknown>, transfer?: Transferable[]): Promise<T>
  terminate(): void
}

export function connect(
  worker: Worker,
  onEvent?: (m: Record<string, unknown>) => void,
  onCrash?: (err: Error) => void,
): Rpc {
  let next = 0
  const pending = new Map<number, Pending>()
  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { id?: number; result?: unknown; error?: string }
    if (typeof m?.id !== 'number') return onEvent?.(e.data)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.result)
  }
  // A worker that fails to load or throws at the top level never answers, so
  // everything waiting on it has to be told rather than left hanging.
  worker.onerror = (e: ErrorEvent) => {
    e.preventDefault()
    const err = new Error(e.message || 'worker failed')
    failAll(err)
    onCrash?.(err)
  }

  return {
    call<T>(op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []) {
      const id = next++
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        worker.postMessage({ ...args, op, id }, transfer)
      })
    },
    terminate() {
      worker.terminate()
      failAll(new Error('worker stopped'))
    },
  }
}

/** What a handler returns: the result, and any buffers to hand over rather than copy. */
export type Reply = { result?: unknown; transfer?: Transferable[] }

type Scope = {
  postMessage(m: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent) => void) | null
}

/** The worker side: run `handlers[op]` for each request and post the answer back. */
export function serve(handlers: Record<string, (args: Record<string, unknown>) => Promise<Reply>>) {
  const scope = self as unknown as Scope
  scope.onmessage = async (e: MessageEvent) => {
    const { id, op, ...args } = e.data as { id: number; op: string } & Record<string, unknown>
    try {
      const handler = handlers[op]
      if (!handler) throw new Error(`unknown op ${op}`)
      const { result, transfer = [] } = await handler(args)
      scope.postMessage({ id, result }, transfer)
    } catch (err) {
      scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** Post an event (no id) from inside a worker. */
export function emit(m: Record<string, unknown>) {
  ;(self as unknown as Scope).postMessage(m)
}
