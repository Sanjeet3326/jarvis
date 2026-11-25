import { BRIDGE_HTTP_URL } from '../config'
import { getMic } from './audio'
import { saidWithin, speakingNow, speakingSince } from './tts'
import { startVad, type Vad } from './vad'
import { caps } from './capabilities'
import * as speaker from './speaker'
import * as wakeword from './wakeword'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name, from a partial — waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
}

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
const WAKE_DEBOUNCE = 1500

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 *
 * Deepgram adds its own, and keeps inventing more: with an Indian accent
 * "Hey Jarvis" came back as "Service", "Hey, service", "Day service", "His
 * service" and "Disarmice", even with the name given to it as a keyterm.
 * Listing them one by one cannot keep up, but they share a shape — a word
 * ending in -arvis, -ervice, -armice — so that is matched instead, and only
 * as the first word, or second after a greeting-like one, so "the customer
 * service was bad" mid-sentence never wakes him. With the voice lock on,
 * only you can say any of it.
 */
const GREETING = String.raw`(?:hey|hi|hai|ok|okay|yo|day|they|his|he|hay|ay|a)`
/**
 * The wake name is now "Saji". Deepgram has never heard it either, so the
 * same trick applies: match the sound shape — s, a vowel, a j/g/z/ch sound, an
 * ee — and the spellings it actually produces (Sushi, Sergey, Sadie, Sanji…),
 * only at the start. wakeword.ts recognises the sound itself and catches the
 * rest; this is the half that needs no recordings.
 */
const NAMEISH = String.raw`(?:sa+h?(?:j+|g+|z+|dg|ch)h?(?:i+|ee|ie|y|e)|sa[\s-]?(?:ji|jee|gee|g)|sanji|sajid|sushi|sergei|sergey|sergi|sadie|saggy|sachi|sage)`

/** His name at the very start of an utterance, with any greeting before it.
 *  Shared with App.tsx, which strips it off a command the same way. */
export const CALL_AT_START = String.raw`^\W*(?:${GREETING}[\s,.]+)?${NAMEISH}\b(?!'s)`

const WAKE = new RegExp(
  `${CALL_AT_START}|\\b(?:hey|hi|ok|okay|yo)?[\\s,]*(?:saji|sajji|saaji|saajee|sajee)\\b(?!'s)`,
  'i',
)

/** Everything after the wake phrase, which is usually the actual command. */
function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

type Word = { w: string; s: number; e: number }

/**
 * The command after a wake name the transcriber mis-spelt: whatever was said
 * after the moment the wake-word detector heard the name. `heardS` is that
 * moment, in seconds from the start of the recording.
 */
function afterHeard(words: Word[] | undefined, heardS: number): string {
  if (!words?.length) return ''
  return words
    .filter((w) => w.s >= heardS - 0.25)
    .map((w) => w.w)
    .join(' ')
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

/** The detector reports when it finished thinking, not when the audio was:
 *  the 2048-sample tap and one model step sit in between. */
const DETECTOR_LAG_MS = 180

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * A barge-in this soon after he starts a sentence is him, not you.
 *
 * Echo cancellation and the raised guard threshold stop most of his playback
 * reaching the detector, but the attack of the very first syllable is the
 * loudest, least-cancelled thing in the whole answer — it arrives before the
 * canceller has adapted to it. Without this, a long answer could interrupt
 * itself on its own first word, which reads as JARVIS refusing to speak.
 *
 * Kept short deliberately. This is the one window where a genuine interruption
 * is also least likely: the user has not yet heard enough to want to stop him.
 */
const SELF_GUARD_MS = 350

/**
 * With the voice lock on, a barge-in waits this long so there is enough of the
 * new voice to recognise. Without it anyone talking in the room would cut him
 * off mid-answer, even though what they said would then be ignored.
 */
const BARGE_CHECK_MS = 900

/** How the voice lock's verdict reads in the diagnostics panel. */
const verdict = (v: speaker.Verdict) =>
  v.score === null ? v.why : `${v.why} (${v.score.toFixed(2)})`

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000
/** ...unless they are audibly still talking, in which case up to this long. */
const TALKING_MAX_MS = 45000
/** Above this many words a thought is "long", and ends only on a real pause... */
const LONG_THOUGHT_WORDS = 12
/** ...of this much quiet after the last sign of speech. */
const LONG_QUIET_MS = 1500
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
  /** Is the user audibly speaking right now? */
  speaking?: () => boolean
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  /**
   * Send — unless they are still talking. MAX_HOLD_MS used to fire regardless,
   * so in a long explanation with pauses he answered mid-sentence, the rest of
   * the sentence then interrupted his answer, and the thought was split into
   * pieces he answered one by one. Now the hold lasts while speech continues,
   * up to TALKING_MAX_MS from the start, so a stuck detector cannot hold a turn
   * open for ever.
   */
  let lastVoice = 0
  const fireWhenQuiet = () => {
    const now = Date.now()
    if (h.speaking?.()) lastVoice = now
    // A long thought needs a real pause, not a breath, before it counts as
    // finished: people explaining something stop to think mid-way.
    const needQuiet = wordCount(held) > LONG_THOUGHT_WORDS ? LONG_QUIET_MS : 0
    const stillGoing = h.speaking?.() || now - lastVoice < needQuiet
    if (stillGoing && now - firstAt < TALKING_MAX_MS) {
      timer = setTimeout(fireWhenQuiet, 200)
      return
    }
    fire()
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // A transcript means they were speaking until a moment ago.
      lastVoice = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fireWhenQuiet, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      // The transcriber ends nearly every segment with a full stop, so for a
      // long thought a full stop is not evidence they are done.
      if (wait === 0 && wordCount(held) <= LONG_THOUGHT_WORDS) {
        fire()
        return
      }
      timer = setTimeout(fireWhenQuiet, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Hearing himself
// ---------------------------------------------------------------------------

// Letters, combining marks and digits of any script: an a-z-only filter turned
// a Hindi-script sentence into nothing, which isEcho then threw away as echo.
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
const OVERRIDE =
  /\b(stop|wait|saji|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\b/i

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
/**
 * His own words at the START of what was heard, as opposed to all of it.
 *
 * The recording that carries the user's command often begins while his short
 * reply ("Yes, sir.") is still coming out of the speakers, so the transcript
 * arrives as "Yes, sir. Check my mail." Returns how many leading words are
 * his and the rest, or null when the sentence does not start with his words
 * or nothing of the user's would be left.
 */
function leadingEcho(heard: string, spoken: string): { rest: string; n: number } | null {
  if (!spoken) return null
  const mine = new Set(norm(spoken).split(' ').filter(Boolean))
  const raw = heard.trim().split(/\s+/)
  let n = 0
  while (n < raw.length) {
    const w = norm(raw[n])
    if (!w || !mine.has(w)) break
    n++
  }
  if (n === 0 || n >= raw.length) return null
  return { rest: raw.slice(n).join(' '), n }
}

/** How much the voice lock is relaxed for a recording that is partly his own
 *  voice: the mixture always scores lower than the user alone. */
const MIXED_SLACK = 0.15

function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (OVERRIDE.test(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' '))
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which input engine is running: 'elevenlabs' (VAD+Scribe) or 'browser'. */
  engine: 'browser',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
  /** The last 40 transcripts with the voice lock's verdict on each — what was
   *  said beside who it was judged to be, which neither log shows alone. */
  log: [] as { text: string; mode: VoiceMode; ok: boolean; score: number | null; at: number }[],
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string) {
  diag.dropped = why
  // Into logs/desktop.log via the desktop app, so a bad session can be read
  // afterwards instead of being lost with the window.
  console.info(`[jarvis] voice: ${why}`)
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

/**
 * Pick the voice engine and start it.
 *
 * Two engines, chosen by what the bridge reported at boot (see capabilities.ts):
 *   - ElevenLabs available -> local voice-activity detection for instant
 *     barge-in, and ElevenLabs Scribe for the words. The reliable path.
 *   - nothing configured -> the browser's own SpeechRecognition, so a student
 *     with no keys still has a working assistant. Less robust, but free and
 *     zero-setup, and guarded by a heartbeat so its silent death is recovered.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers): Promise<Voice> {
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return { stop: () => {}, live: () => false }
  }
  // 'cloud' is whichever transcriber the bridge holds a key for — ElevenLabs
  // or Deepgram; the page never needs to know which.
  diag.engine = caps().stt ? 'cloud' : 'browser'
  return caps().stt ? startElevenVoice(h) : startBrowserVoice(h)
}

/** VAD + ElevenLabs Scribe. */
async function startElevenVoice(h: VoiceHandlers): Promise<Voice> {
  let lastWake = 0
  let vad: Vad | null = null

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: { blob: Blob; from: number; to: number }[] = []
  let draining = false

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
    speaking: () => vad?.meter().speaking ?? false,
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async ({ blob, from, to }: { blob: Blob; from: number; to: number }) => {
    const mode = h.mode()
    if (mode === 'deaf') return
    const t0 = performance.now()
    // Who is speaking is checked alongside what they said, not after it, so
    // the voice lock costs no extra wait on top of the transcription.
    const who = speaker.verifyAudio(blob)
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      })
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        diag.restarts++
        diag.lastError = `stt ${res.status}`
        drop(`transcription failed (${res.status})`)
        return
      }
      const { text, words } = (await res.json()) as { text?: string; words?: Word[] }
      let said = (text ?? '').trim()
      diag.lastError = ''

      // "Yes, sir. Check my mail." — his reply caught on the front of the
      // command. Keep only the user's part, and remember that the audio was a
      // mixture so the voice lock can allow for it.
      const glued = mode === 'command' ? leadingEcho(said, saidWithin(8000)) : null
      if (glued) said = glued.rest

      if (!said) {
        drop('nothing intelligible in the segment')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest.
      if (isEcho(said, speakingNow())) {
        drop('echo of his own voice')
        return
      }

      diag.heard = said
      diag.heardAt = Date.now()

      let v = await who
      if (glued && !v.ok && v.score != null && v.score >= speaker.threshold() - MIXED_SLACK) {
        v = { ...v, ok: true, why: 'your voice (mixed with his reply)' }
      }
      diag.log.push({ text: said, mode, ok: v.ok, score: v.score, at: Date.now() })
      console.info(
        `[jarvis] voice: heard (${mode}) "${said}" · ${v.ok ? 'your voice' : 'NOT your voice'}` +
          ` ${v.score == null ? '' : v.score.toFixed(2)}`,
      )
      if (diag.log.length > 40) diag.log.shift()
      if (!v.ok) {
        drop(`ignored "${said.slice(-30)}" — ${verdict(v)}`)
        return
      }

      if (mode === 'wake') {
        const byName = WAKE.test(said)
        // The detector heard "Hey Saji" in this stretch of audio, whatever the
        // transcriber made of it.
        const heard = byName ? null : wakeword.firedBetween(from - 300, to + 400)
        if ((byName || heard !== null) && Date.now() - lastWake > WAKE_DEBOUNCE) {
          lastWake = Date.now()
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          h.onWake(
            byName ? afterWake(said) : afterHeard(words, (heard! - DETECTOR_LAG_MS - from) / 1000),
          )
        } else {
          drop(`heard "${said.slice(-40)}" — not his name`)
        }
        return
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      assemble.feed(said, vad?.meter().speaking ?? false)
    } catch (err) {
      diag.restarts++
      diag.lastError = String(err)
      drop('could not reach the speech service')
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pendingAudio.length) {
        await transcribe(pendingAudio.shift()!)
      }
    } finally {
      draining = false
    }
  }

  vad = await startVad({
    onStart: () => {
      const mode = h.mode()
      diag.mode = mode
      diag.sessions++
      if (mode === 'deaf') return
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') assemble.cancel()
      // The barge-in. In guard mode the user has started talking over him, and
      // because the guard threshold is high this is a real interruption rather
      // than leaked playback — so cut him off now, do not wait for the words.
      if (mode === 'guard') {
        const since = speakingSince()
        if (since && Date.now() - since < SELF_GUARD_MS) {
          diag.selfGuarded++
          return
        }
        if (speaker.locked()) {
          void speaker.verifySoon(BARGE_CHECK_MS).then((v) => {
            if (v.ok) h.onSpeechStart()
            else drop(`kept talking over another voice — ${verdict(v)}`)
          })
          return
        }
        h.onSpeechStart()
      }
    },
    onEnd: (blob, ms) => {
      const to = performance.now()
      pendingAudio.push({ blob, from: to - ms, to })
      void drain()
    },
    onLevel: (v) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = h.mode()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) {
        // Re-sent unchanged while they keep talking: the app reads any partial
        // as "still speaking" and holds the listening window open for it.
        if (v > 0.04) h.onPartial(assemble.held())
        return
      }
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message) => {
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  })
  diag.running = vad.live()

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  const guardPoll = setInterval(() => {
    const mode = h.mode()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
  }, 200)

  return {
    stop: () => {
      clearInterval(guardPoll)
      assemble.cancel()
      vad?.stop()
      diag.running = false
    },
    live: () => vad?.live() ?? false,
  }
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
function startBrowserVoice(h: VoiceHandlers): Voice {
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return { stop: () => {}, live: () => false }
  }

  let stopped = false
  let running = false
  let rec: any = null
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** When the words being assembled started arriving — how far back in the
   *  microphone the voice lock has to look to hear who said them. */
  let since = 0
  /** That span, padded for the recogniser's lag, in milliseconds. */
  const spoken = (pad: number, min: number) =>
    Math.min(8000, Math.max(min, (since ? Date.now() - since : 0) + pad))

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
    since = 0
  }

  const emit = async () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    // Measured before reset() forgets when the words began. The recogniser
    // endpoints 900ms after the last word, so that much trailing quiet is in
    // the window too; the voice lock trims silence before judging.
    const span = spoken(1200, 1500)
    reset()
    if (!text || mode === 'deaf') return
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    const v = await speaker.verifyRecent(span)
    if (!v.ok) {
      drop(`ignored "${text.slice(-30)}" — ${verdict(v)}`)
      return
    }
    if (mode === 'wake') {
      assemble.cancel()
      if (WAKE.test(text) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        h.onWake(afterWake(text))
      } else {
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(() => void emit(), 900)
  }

  const onResult = (e: any) => {
    touch()
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') {
      interim = ''
      return
    }
    let fresh = ''
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) fresh += chunk
      else interim += chunk
    }
    const heard = `${settled}${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!heard) return
    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      interim = ''
      return
    }
    if (mode === 'wake') {
      settled += fresh
      if (WAKE.test(heard) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        const trailing = afterWake(heard)
        reset()
        // A fixed span, not `spoken`: while dormant the recogniser accumulates
        // everything said in the room, and only the name just heard is wanted.
        void speaker.verifyRecent(2500).then((v) => {
          if (!v.ok) {
            drop(`ignored his name — ${verdict(v)}`)
            return
          }
          diag.wakes++
          h.onWake(trailing)
        })
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    // Roughly when this speech began: the recogniser's first result lags the
    // first syllable by a few hundred milliseconds, which `spoken` pads for.
    if (!since) since = Date.now()
    settled += fresh
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      const words = full.split(/\s+/).filter(Boolean).length
      if (mode === 'guard') {
        // An override word cuts through everything below it — "stop" has to
        // work on the first syllable or it is not a stop button.
        if (!OVERRIDE.test(full)) {
          // His own first syllable, same as the premium path. This engine has
          // no energy gate, so without the clock the only defence is the word
          // count below, and a single clear word is exactly what leaks first.
          const since = speakingSince()
          if (since && Date.now() - since < SELF_GUARD_MS) {
            diag.selfGuarded++
            return
          }
          // Two words before this engine believes an interruption. The energy
          // path can be instant because it triggers on loudness the canceller
          // has already had a pass at; here the evidence is a transcript of
          // audio that includes his own playback, and one word of that is not
          // evidence of anything.
          if (words < 2) return
        }
      }
      started = true
      if (mode === 'guard') barged = true
      if (mode === 'guard' && speaker.locked()) {
        void speaker.verifyRecent(spoken(600, 1200)).then((v) => {
          if (v.ok) h.onSpeechStart()
          else drop(`kept talking over another voice — ${verdict(v)}`)
        })
      } else {
        h.onSpeechStart()
      }
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    bumpSilence()
  }

  const spin = () => {
    if (stopped || running) return
    rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-GB'
    rec.onstart = () => {
      running = true
      diag.running = true
      diag.sessions++
      touch()
    }
    rec.onresult = onResult
    rec.onerror = (ev: any) => {
      diag.lastError = String(ev.error ?? '')
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true
        diag.running = false
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    rec.onend = () => {
      running = false
      diag.running = false
      touch()
      rec = null
      if (!stopped) setTimeout(spin, 80)
    }
    try {
      rec.start()
    } catch {
      running = false
      setTimeout(spin, 250)
    }
  }

  spin()

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000) return
    diag.restarts++
    try {
      rec?.abort()
    } catch {
      /* already gone */
    }
    rec = null
    running = false
    diag.running = false
    touch()
    spin()
  }, 5000)

  // The recogniser keeps its words until it decides you have finished, so
  // the wake-word detector — which hears the sound itself — wakes him first.
  const offWake = wakeword.onWake(() => {
    if (h.mode() !== 'wake' || Date.now() - lastWake <= WAKE_DEBOUNCE) return
    lastWake = Date.now()
    reset()
    void speaker.verifyRecent(2500).then((v) => {
      if (!v.ok) {
        drop(`ignored "Hey Saji" — ${verdict(v)}`)
        return
      }
      diag.wakes++
      h.onWake('')
    })
  })

  return {
    stop: () => {
      stopped = true
      offWake()
      clearInterval(health)
      clearSilence()
      assemble.cancel()
      diag.running = false
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
  }
}
