import { useEffect, useState, type MouseEvent } from 'react'
import * as speaker from '../lib/speaker'
import * as wakeword from '../lib/wakeword'

/**
 * The voice-lock panel: record a voiceprint so JARVIS answers only you.
 *
 * Press L to open it. Enrolment is five short lines read aloud — varied on
 * purpose, a question, a command, a plain sentence and the short words people
 * use to interrupt, because a voiceprint built from one kind of sentence is
 * weakest on the others. Then a test button that says plainly whether you, or
 * someone else, would get through, and a strictness slider for when it is
 * too fussy or not fussy enough.
 */

const LINES = [
  'Hey Saji, what is the weather like today?',
  'Saji, open my emails and read me the latest one.',
  'The quick brown fox jumps over the lazy dog by the river.',
  'Hey Saji, play some music and turn the reactor blue.',
  'Saji, stop. Wait. Never mind, cancel that.',
]

/** Long enough for any of the lines at a relaxed pace. */
const SAMPLE_MS = 4500
/** As long as a recording: a short window plus a late start is a test of the
 *  room, not of you. */
const TEST_MS = 5000

/** How many times to say the wake phrase. More helps a little; fewer than
 *  five and one odd recording carries too much weight. */
const WAKE_TAKES = 8
/** One "Hey Saji" at a normal pace, plus a late start. */
const WAKE_MS = 2500
/** Something that is not the wake phrase, so the threshold knows what to
 *  stay above. */
const OTHER_MS = 5000

type Step =
  | { kind: 'idle' }
  | { kind: 'wake'; take: number; endsAt: number }
  | { kind: 'other'; endsAt: number }
  | { kind: 'recording'; line: number; endsAt: number }
  | { kind: 'saving' }
  | { kind: 'testing'; endsAt: number }

export function VoiceLock() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [samples, setSamples] = useState<Float32Array[]>([])
  const [note, setNote] = useState('')
  const [strict, setStrict] = useState(speaker.threshold())
  const [takes, setTakes] = useState<Float32Array[]>([])
  const [other, setOther] = useState<Float32Array | null>(null)
  const [wakeNote, setWakeNote] = useState('')
  const [wakeStrict, setWakeStrict] = useState(wakeword.threshold())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'l' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Countdowns and the model's download progress are both read from outside
  // React, so poll while there is anything on screen that moves.
  useEffect(() => {
    speaker.setEnrolling(open)
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 200)
    return () => clearInterval(id)
  }, [open])

  const d = speaker.lockDiag
  const busy = step.kind !== 'idle'

  /** Buttons keep focus after a click, and Space on a focused button would
   *  also reach the app's own Space shortcut. */
  const press = (fn: () => void) => (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur()
    fn()
  }

  const recordLine = async () => {
    const line = samples.length
    setNote('')
    // Start the download now; it is the slow part, and it overlaps the reading.
    void speaker.loadForEnrolment().catch(() => {})
    try {
      setStep({ kind: 'recording', line, endsAt: Date.now() + SAMPLE_MS })
      const pcm = await speaker.capture(SAMPLE_MS)
      if (speaker.voicedSeconds(pcm) < 1) {
        setNote('That was too quiet to use — read the line again, a little louder.')
        return
      }
      setSamples((s) => [...s, pcm])
    } catch (err) {
      setNote(
        (err as DOMException)?.name === 'NotAllowedError'
          ? 'The microphone is not allowed. Allow it in the address bar and try again.'
          : `Recording failed: ${(err as Error)?.message ?? err}`,
      )
    } finally {
      setStep({ kind: 'idle' })
    }
  }

  const save = async () => {
    setStep({ kind: 'saving' })
    setNote('')
    try {
      const { consistency } = await speaker.enrol(samples)
      // Recommend a threshold a little under how alike your own samples were,
      // never so low that strangers pass or so high that you do not. Other
      // voices land under 0.2 with this model; short clips of you, around 0.5.
      const suggested = Math.min(0.55, Math.max(0.35, Math.round((consistency - 0.12) * 100) / 100))
      speaker.setThreshold(suggested)
      setStrict(suggested)
      setSamples([])
      setNote(
        `Voice lock is on. Your samples matched each other at ${consistency.toFixed(2)}; ` +
          `strictness set to ${suggested.toFixed(2)}. Press Test to check it.`,
      )
    } catch (err) {
      setNote(`Could not save the voiceprint: ${(err as Error)?.message ?? err}`)
    } finally {
      setStep({ kind: 'idle' })
    }
  }

  const test = async () => {
    setNote('')
    setStep({ kind: 'testing', endsAt: Date.now() + TEST_MS })
    try {
      const pcm = await speaker.capture(TEST_MS)
      const voiced = speaker.voicedSeconds(pcm)
      const s = await speaker.score(pcm)
      speaker.lockDiag.tests.push({ score: s, voiced, at: Date.now() })
      // Noise passes the energy gate as "speech" in a loud room, so too little
      // of it is reported as a failed test, not as a verdict on a voice.
      if (s === null || voiced < 1.5)
        setNote(
          `Not enough speech heard (${voiced.toFixed(1)}s). Start talking as soon as you press ` +
            'Test, and keep going for the whole countdown.',
        )
      else
        setNote(
          s >= speaker.threshold()
            ? `✓ Recognised (${s.toFixed(2)} ≥ ${speaker.threshold().toFixed(2)}). JARVIS would answer this voice.`
            : `✗ Not recognised (${s.toFixed(2)} < ${speaker.threshold().toFixed(2)}). JARVIS would ignore this voice.`,
        )
    } catch (err) {
      setNote(`Test failed: ${(err as Error)?.message ?? err}`)
    } finally {
      setStep({ kind: 'idle' })
    }
  }

  const recordTake = async () => {
    setWakeNote('')
    void wakeword.prepare().catch(() => {})
    try {
      setStep({ kind: 'wake', take: takes.length, endsAt: Date.now() + WAKE_MS })
      const pcm = await speaker.capture(WAKE_MS)
      if (speaker.voicedSeconds(pcm) < 0.3) {
        setWakeNote('Did not hear it — say “Hey Saji” as soon as the dot turns red.')
        return
      }
      setTakes((t) => [...t, pcm])
    } catch (err) {
      setWakeNote(`Recording failed: ${(err as Error)?.message ?? err}`)
    } finally {
      setStep({ kind: 'idle' })
    }
  }

  const recordOther = async () => {
    setWakeNote('')
    try {
      setStep({ kind: 'other', endsAt: Date.now() + OTHER_MS })
      setOther(await speaker.capture(OTHER_MS))
    } catch (err) {
      setWakeNote(`Recording failed: ${(err as Error)?.message ?? err}`)
    } finally {
      setStep({ kind: 'idle' })
    }
  }

  const saveWake = async () => {
    setStep({ kind: 'saving' })
    setWakeNote('Building your wake word…')
    try {
      const r = await wakeword.enrol(takes, other ? [other] : [])
      setWakeStrict(r.threshold)
      setTakes([])
      setOther(null)
      setWakeNote(
        `“Hey Saji” is on, from ${r.kept} recordings. Yours matched each other at ` +
          `${r.self.toFixed(2)}, other speech at ${r.other.toFixed(2)}; sensitivity set to ` +
          `${r.threshold.toFixed(2)}. Close this panel and try it.`,
      )
    } catch (err) {
      setWakeNote(`Could not build it: ${(err as Error)?.message ?? err}`)
    } finally {
      setStep({ kind: 'idle' })
    }
  }

  const forget = () => {
    speaker.forget()
    setSamples([])
    setNote('Voiceprint deleted. JARVIS answers anyone again.')
  }

  const left = (endsAt: number) => Math.max(0, (endsAt - Date.now()) / 1000).toFixed(1)

  if (!open) {
    return d.enrolled ? <div className="vlock-badge">VOICE LOCK · L</div> : null
  }

  return (
    <div className="vlock" role="dialog" aria-label="Voice lock">
      <div className="diag-head">VOICE LOCK · L to close</div>

      <div className={d.enrolled ? 'diag-ok' : 'diag-bad'}>
        {d.enrolled ? '● ON — only your voice is answered' : '● OFF — anyone can talk to JARVIS'}
      </div>
      <div className="vlock-model">
        model:{' '}
        {d.model === 'loading'
          ? `downloading ${Math.round(d.progress * 100)}%`
          : d.model === 'failed'
            ? `failed — ${d.error}`
            : d.model}
      </div>

      <div className="diag-sec">{d.enrolled ? 'RE-RECORD YOUR VOICE' : 'RECORD YOUR VOICE'}</div>
      <p className="vlock-help">
        Sit where you normally talk to JARVIS. Press Record and read the line out loud in your
        normal voice. Any language works.
      </p>

      {step.kind === 'recording' ? (
        <div className="vlock-line vlock-live">
          ● Speak now ({left(step.endsAt)}s): “{LINES[step.line]}”
        </div>
      ) : samples.length < LINES.length ? (
        <div className="vlock-line">
          Line {samples.length + 1} of {LINES.length}: “{LINES[samples.length]}”
        </div>
      ) : (
        <div className="vlock-line">All {LINES.length} lines recorded.</div>
      )}

      <div className="vlock-buttons">
        {samples.length < LINES.length && (
          <button disabled={busy} onClick={press(() => void recordLine())}>
            Record line {samples.length + 1}
          </button>
        )}
        {samples.length >= 3 && (
          <button disabled={busy} onClick={press(() => void save())}>
            {step.kind === 'saving' ? 'Saving…' : 'Save voiceprint'}
          </button>
        )}
        {samples.length > 0 && (
          <button disabled={busy} onClick={press(() => setSamples([]))}>
            Start over
          </button>
        )}
      </div>

      {d.enrolled && (
        <>
          <div className="diag-sec">TEST AND TUNE</div>
          {step.kind === 'testing' && (
            <div className="vlock-line vlock-live">
              ● Speak now ({left(step.endsAt)}s) — say anything, keep talking until it ends
            </div>
          )}
          <div className="vlock-buttons">
            <button disabled={busy} onClick={press(() => void test())}>
              {step.kind === 'testing' ? `Listening… ${left(step.endsAt)}s` : 'Test a voice'}
            </button>
            <button disabled={busy} onClick={press(forget)}>
              Delete voiceprint
            </button>
          </div>
          <label className="vlock-slider">
            strictness {strict.toFixed(2)}
            <input
              type="range"
              min={0.2}
              max={0.8}
              step={0.01}
              value={strict}
              onChange={(e) => {
                const t = Number(e.target.value)
                setStrict(t)
                speaker.setThreshold(t)
              }}
            />
          </label>
          <p className="vlock-help">
            Ignores you too often → lower it. Answers other people → raise it.
          </p>
          <div className="vlock-model">
            last check:{' '}
            {d.checks
              ? `${d.lastOk ? 'accepted' : 'ignored'} · ${d.lastScore?.toFixed(2) ?? '—'} · ${d.lastWhy}`
              : '—'}{' '}
            · ignored {d.rejected} of {d.checks}
          </div>
        </>
      )}

      {note && <div className="vlock-note">{note}</div>}

      <div className="diag-sec">WAKE WORD · “HEY SAJI”</div>
      <div className={wakeword.enrolled() ? 'diag-ok' : 'diag-bad'}>
        {wakeword.enrolled()
          ? `● ON — recognised from your own ${wakeword.wakeDiag.templates} recordings`
          : '● OFF — only the transcript is checked for “Saji”'}
      </div>
      <p className="vlock-help">
        Say “Hey Saji” the way you normally would, once per recording. Then one recording of
        anything else, so it learns what not to wake on.
      </p>
      {step.kind === 'wake' && (
        <div className="vlock-line vlock-live">● Say “Hey Saji” now ({left(step.endsAt)}s)</div>
      )}
      {step.kind === 'other' && (
        <div className="vlock-line vlock-live">
          ● Talk about anything else — not the wake word ({left(step.endsAt)}s)
        </div>
      )}
      <div className="vlock-buttons">
        {takes.length < WAKE_TAKES && (
          <button disabled={busy} onClick={press(() => void recordTake())}>
            Record “Hey Saji” {takes.length + 1} of {WAKE_TAKES}
          </button>
        )}
        {takes.length >= 3 && !other && (
          <button disabled={busy} onClick={press(() => void recordOther())}>
            Record something else
          </button>
        )}
        {takes.length >= 5 && other && (
          <button disabled={busy} onClick={press(() => void saveWake())}>
            {step.kind === 'saving' ? 'Building…' : 'Save wake word'}
          </button>
        )}
        {(takes.length > 0 || other) && (
          <button
            disabled={busy}
            onClick={press(() => {
              setTakes([])
              setOther(null)
            })}
          >
            Start over
          </button>
        )}
        {wakeword.enrolled() && (
          <button
            disabled={busy}
            onClick={press(() => {
              wakeword.forget()
              setWakeNote('Wake word recordings deleted.')
            })}
          >
            Delete wake word
          </button>
        )}
      </div>
      {wakeword.enrolled() && (
        <>
          <label className="vlock-slider">
            sensitivity {wakeStrict.toFixed(2)}
            <input
              type="range"
              min={0.3}
              max={0.9}
              step={0.01}
              value={wakeStrict}
              onChange={(e) => {
                const t = Number(e.target.value)
                setWakeStrict(t)
                wakeword.setThreshold(t)
              }}
            />
          </label>
          <p className="vlock-help">
            Misses “Hey Saji” → lower it. Wakes when you did not call → raise it.
          </p>
          <div className="vlock-model">
            heard it {wakeword.wakeDiag.fires} times · last {wakeword.wakeDiag.lastScore.toFixed(2)} ·
            closest {wakeword.wakeDiag.peak.toFixed(2)} · model {wakeword.wakeDiag.model}
          </div>
        </>
      )}
      {wakeNote && <div className="vlock-note">{wakeNote}</div>}
    </div>
  )
}
