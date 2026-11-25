import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, normalise } from '../bridge/fast.mjs'

const tool = (s) => parse(s)?.tool ?? null

test('strips polite padding and punctuation', () => {
  assert.equal(normalise('Okay. Saji, can you open YouTube, please?'), 'open youtube')
})

test('opens known sites in Chrome', () => {
  assert.deepEqual(parse('Open YouTube.'), {
    tool: 'navigate',
    args: { url: 'https://www.youtube.com/' },
    say: 'Opening YouTube.',
  })
  assert.equal(parse('go to gmail')?.args.url, 'https://mail.google.com/')
  assert.equal(parse('open github dot com')?.args.url, 'https://github.com/')
})

test('opens apps by name', () => {
  assert.deepEqual(parse('Open Spotify'), {
    tool: 'pc_open_app',
    args: { name: 'spotify' },
    say: 'Opening Spotify.',
  })
  assert.equal(tool('launch vs code'), 'pc_open_app')
})

test('closes apps by name', () => {
  assert.equal(parse('Close Notepad.')?.args.name, 'notepad')
  assert.equal(parse('quit the spotify app')?.args.name, 'spotify')
})

test('volume and media keys', () => {
  assert.deepEqual(parse('set volume to 40 percent')?.args, { action: 'set', level: 40 })
  assert.equal(parse('volume up')?.args.action, 'up')
  assert.equal(parse('Mute.')?.args.action, 'mute')
  assert.equal(parse('pause the music')?.args.action, 'play_pause')
  assert.equal(parse('next song')?.args.action, 'next')
})

test('searches', () => {
  assert.equal(
    parse('search lofi music on youtube')?.args.url,
    'https://www.youtube.com/results?search_query=lofi%20music',
  )
  assert.equal(parse('google weather in delhi')?.args.url, 'https://www.google.com/search?q=weather%20in%20delhi')
})

test('leaves anything vague, compound or conversational to the agent', () => {
  for (const s of [
    'close it',
    'Close the. Close it. Close it.',
    'open this',
    'open YouTube and play some music',
    'Move the MATLAB in my actual laptop and the clot in my monitor.',
    'Tell me some news about any politics news.',
    'close this tab',
    'close yourself',
    'what is the volume',
    'open the file I was working on yesterday',
    'go to sleep',
    'start the timer',
    'search for the latest politics news',
  ]) {
    assert.equal(parse(s), null, s)
  }
})
