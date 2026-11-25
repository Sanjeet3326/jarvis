/**
 * Instant commands: the everyday orders that do not need a model.
 *
 * Why. Every turn through the agent pays for two model calls — one to choose
 * the tool, one to say "done" — plus the tool itself. Measured, "open YouTube"
 * took 9–11s and "close it" 9s, of which the tool was about a second. For a
 * fixed set of plain commands the right tool and its arguments are already in
 * the words, so they are matched here and run directly, with a spoken line
 * from a template. One to two seconds instead of ten.
 *
 * Deliberately narrow. A command is only taken when the WHOLE utterance is one
 * of these shapes; anything with "and", a pronoun ("close it"), or a question
 * goes to the agent as before. A wrong instant action is worse than a slow
 * right one, so when in doubt this returns null. And when an instant action
 * fails, the bridge hands the request to the agent with the failure attached,
 * so the user still gets a proper answer.
 */

/** Spoken name → URL, for "open X". Only sites, never things that may be desktop apps. */
export const SITES = {
  youtube: ['YouTube', 'https://www.youtube.com/'],
  'you tube': ['YouTube', 'https://www.youtube.com/'],
  gmail: ['Gmail', 'https://mail.google.com/'],
  google: ['Google', 'https://www.google.com/'],
  'google drive': ['Google Drive', 'https://drive.google.com/'],
  drive: ['Google Drive', 'https://drive.google.com/'],
  'google docs': ['Google Docs', 'https://docs.google.com/'],
  'google sheets': ['Google Sheets', 'https://sheets.google.com/'],
  'google calendar': ['Google Calendar', 'https://calendar.google.com/'],
  calendar: ['Google Calendar', 'https://calendar.google.com/'],
  'google maps': ['Google Maps', 'https://maps.google.com/'],
  maps: ['Google Maps', 'https://maps.google.com/'],
  github: ['GitHub', 'https://github.com/'],
  chatgpt: ['ChatGPT', 'https://chatgpt.com/'],
  claude: ['Claude', 'https://claude.ai/'],
  linkedin: ['LinkedIn', 'https://www.linkedin.com/'],
  instagram: ['Instagram', 'https://www.instagram.com/'],
  facebook: ['Facebook', 'https://www.facebook.com/'],
  twitter: ['X', 'https://x.com/'],
  reddit: ['Reddit', 'https://www.reddit.com/'],
  netflix: ['Netflix', 'https://www.netflix.com/'],
  amazon: ['Amazon', 'https://www.amazon.in/'],
  flipkart: ['Flipkart', 'https://www.flipkart.com/'],
  wikipedia: ['Wikipedia', 'https://www.wikipedia.org/'],
  'stack overflow': ['Stack Overflow', 'https://stackoverflow.com/'],
}

/** Words that open or close a request without changing it. */
const LEAD =
  /^(?:(?:hey|hi|ok|okay|so|now|then|please|just|jarvis|saji|sajji|sergey|can you|could you|would you|will you|i want you to|go ahead and)\s+)+/
const TAIL = /(?:\s+(?:please|now|for me|right now|thanks|thank you))+$/

/** Things that mean "the one we were just talking about" — the agent has that context, we do not. */
const VAGUE = /^(?:it|this|that|these|those|them|everything|all|the (?:window|app|tab|page|thing))$/

const SEARCH_ENGINES = new Set(['google', 'youtube', 'you tube'])

/** Lower case, no punctuation, single spaces, polite padding removed. */
export function normalise(text) {
  let t = String(text ?? '')
    .toLowerCase()
    .replace(/[“”"’']/g, '')
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (let i = 0; i < 3; i++) t = t.replace(LEAD, '').replace(TAIL, '').trim()
  return t
}

/** "youtube.com", "news.ycombinator.com" → a URL; anything else → null. */
function domainUrl(s) {
  const d = s.replace(/\s+dot\s+/g, '.').replace(/\s+/g, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|net|in|io|dev|ai|co|app|me|gov|edu)$/.test(d)
    ? `https://${d}/`
    : null
}

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())
const pct = (s) => Math.max(0, Math.min(100, Math.round(Number(s))))

/**
 * Match one utterance to one action, or null.
 *
 * Returns { tool, args, say } where `tool` is 'navigate' or a pc_* tool name,
 * and `say` is the line spoken as it runs.
 */
export function parse(text) {
  const t = normalise(text)
  if (!t || t.length > 80) return null
  // Compound or conditional orders need the agent.
  if (/\b(and|then|after|before|if|unless|but|also)\b/.test(t)) return null
  // A verb said twice ("close the close it") is a garbled transcript, not an order.
  if ((t.match(/\b(open|close|quit|launch|exit)\b/g) ?? []).length > 1) return null

  let m

  // --- searches ---------------------------------------------------------
  if (
    (m = t.match(/^(?:search|look up|find) (?:on )?youtube for (.+)$/)) ||
    (m = t.match(/^(?:search|look up|find|play) (.+?) on youtube$/)) ||
    (m = t.match(/^youtube search (.+)$/))
  ) {
    const q = m[1].trim()
    return {
      tool: 'navigate',
      args: { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
      say: `Searching YouTube for ${q}.`,
    }
  }
  if (
    (m = t.match(/^google (.+)$/)) ||
    (m = t.match(/^search google for (.+)$/)) ||
    (m = t.match(/^search (.+?) on google$/))
  ) {
    const q = m[1].trim()
    if (!SEARCH_ENGINES.has(q)) {
      return {
        tool: 'navigate',
        args: { url: `https://www.google.com/search?q=${encodeURIComponent(q)}` },
        say: `Searching Google for ${q}.`,
      }
    }
  }

  // --- volume -------------------------------------------------------------
  if ((m = t.match(/^(?:set |change |put )?(?:the )?(?:volume|sound) (?:to |at )?(\d{1,3})(?: percent| %)?$/))) {
    const n = pct(m[1])
    return { tool: 'pc_volume', args: { action: 'set', level: n }, say: `Volume at ${n}.` }
  }
  if (/^(?:turn (?:the )?)?(?:volume|sound) up$|^(?:increase|raise) (?:the )?(?:volume|sound)$|^louder$|^turn it up$/.test(t)) {
    return { tool: 'pc_volume', args: { action: 'up' }, say: 'Volume up.' }
  }
  if (/^(?:turn (?:the )?)?(?:volume|sound) down$|^(?:decrease|lower|reduce) (?:the )?(?:volume|sound)$|^quieter$|^turn it down$/.test(t)) {
    return { tool: 'pc_volume', args: { action: 'down' }, say: 'Volume down.' }
  }
  if (/^mute(?: the)?(?: volume| sound| audio| pc| laptop)?$/.test(t)) {
    return { tool: 'pc_volume', args: { action: 'mute' }, say: 'Muted.' }
  }
  if (/^unmute(?: the)?(?: volume| sound| audio| pc| laptop)?$/.test(t)) {
    return { tool: 'pc_volume', args: { action: 'unmute' }, say: 'Unmuted.' }
  }

  // --- media keys ---------------------------------------------------------
  if (/^(?:pause|resume|play)(?: the)?(?: music| song| video| track| playback)?$/.test(t)) {
    return { tool: 'pc_media', args: { action: 'play_pause' }, say: t.startsWith('pause') ? 'Paused.' : 'Playing.' }
  }
  if (/^(?:next|skip)(?: this)?(?: song| track| video)?$|^play (?:the )?next (?:song|track|video)$/.test(t)) {
    return { tool: 'pc_media', args: { action: 'next' }, say: 'Next track.' }
  }
  if (/^(?:previous|last)(?: song| track| video)$|^play (?:the )?previous (?:song|track|video)$|^go back a (?:song|track)$/.test(t)) {
    return { tool: 'pc_media', args: { action: 'previous' }, say: 'Previous track.' }
  }
  if (/^stop(?: the)? (?:music|song|video|playback)$/.test(t)) {
    return { tool: 'pc_media', args: { action: 'stop' }, say: 'Stopped.' }
  }

  // --- open ---------------------------------------------------------------
  if ((m = t.match(/^(?:open|launch|go to|bring up|pull up)(?: up)? (?:the )?(.+?)(?: website| site| app| application)?$/))) {
    const target = m[1].trim()
    if (VAGUE.test(target) || /\b(tab|window|file|folder|document|email|mail from)\b/.test(target)) return null
    const site = SITES[target]
    if (site) return { tool: 'navigate', args: { url: site[1] }, say: `Opening ${site[0]}.` }
    const url = domainUrl(target)
    if (url) return { tool: 'navigate', args: { url }, say: `Opening ${target.replace(/\s+dot\s+/g, '.')}.` }
    // "go to" is about places, not programs.
    if (/^(?:go to)/.test(t)) return null
    if (target.split(' ').length > 4) return null
    return { tool: 'pc_open_app', args: { name: target }, say: `Opening ${titleCase(target)}.` }
  }

  // --- close --------------------------------------------------------------
  if ((m = t.match(/^(?:close|quit|exit)(?: the)? (.+?)(?: app| application| window)?$/))) {
    const target = m[1].trim()
    if (VAGUE.test(target) || /\b(tab|tabs|saji|jarvis|yourself|you)\b/.test(target)) return null
    if (target.split(' ').length > 4) return null
    return { tool: 'pc_close_app', args: { name: target }, say: `Closing ${titleCase(target)}.` }
  }

  return null
}

/** The first sentence of a tool's text, for saying what went wrong. */
export function resultText(result) {
  return (result?.content ?? [])
    .map((c) => (c?.type === 'text' ? c.text : ''))
    .join(' ')
    .trim()
}

/**
 * What the agent should know about an instant action it did not take, so that
 * "close it" or "turn it back up" next turn still makes sense.
 */
export function describe(cmd) {
  if (cmd.tool === 'navigate') return `opened ${cmd.args.url} in the browser`
  if (cmd.tool === 'launch') return `opened the app ${cmd.args.app.name}`
  return `${cmd.tool}(${JSON.stringify(cmd.args)})`
}
