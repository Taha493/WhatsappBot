import { describe, expect, it } from 'vitest'
import { splitMessage, toWhatsApp } from '../src/lib/format.js'
import { parseQuickAction } from '../src/core/quick-actions.js'
import { maskId } from '../src/lib/logger.js'

describe('toWhatsApp', () => {
  it('converts Markdown to WhatsApp formatting', () => {
    expect(toWhatsApp('## Tasks\n**Submit** the __report__\n* one\n- two')).toBe(
      '*Tasks*\n*Submit* the *report*\n• one\n• two',
    )
    expect(toWhatsApp('[docs](https://example.com)')).toBe('docs (https://example.com)')
  })

  it('leaves WhatsApp formatting alone', () => {
    expect(toWhatsApp('*#3* Submit — _tomorrow_')).toBe('*#3* Submit — _tomorrow_')
  })
})

describe('splitMessage', () => {
  it('keeps short messages whole', () => {
    expect(splitMessage('hello')).toEqual(['hello'])
  })

  it('splits long messages on line breaks under the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => Array(5).fill(`line ${i}`).join(' ')).join('\n')
    const parts = splitMessage(text, 300)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 300)).toBe(true)
    expect(parts.join('\n')).toBe(text)
  })
})

describe('parseQuickAction', () => {
  it.each([
    ['done', { kind: 'done' }],
    ['Done!', { kind: 'done' }],
    ['✅', { kind: 'done' }],
    ['snooze', { kind: 'snooze', minutes: 60 }],
    ['snooze 30m', { kind: 'snooze', minutes: 30 }],
    ['Snooze for 2 hours', { kind: 'snooze', minutes: 120 }],
    ['later', { kind: 'snooze', minutes: 60 }],
    ['tomorrow', { kind: 'tomorrow' }],
  ])('%s', (text, expected) => {
    expect(parseQuickAction(text)).toEqual(expected)
  })

  it('leaves everything else to the assistant', () => {
    expect(parseQuickAction('move it to Friday')).toBeNull()
    expect(parseQuickAction('snooze 0m')).toBeNull()
  })
})

describe('maskId', () => {
  it('hides the middle of phone numbers', () => {
    expect(maskId('923001234567@s.whatsapp.net')).toBe('92300****567@s.whatsapp.net')
  })
})
