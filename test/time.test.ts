import { describe, expect, it } from 'vitest'
import {
  formatDue,
  guessTimezone,
  isOverdue,
  localDayRange,
  nextOccurrence,
  normalizeRecurrence,
  parseLocalDue,
  toLocalIso,
} from '../src/tasks/time.js'
import { MONDAY_9AM, ZONE } from './helpers.js'

describe('parseLocalDue', () => {
  it('reads a local datetime in the user timezone', () => {
    const due = parseLocalDue('2026-10-27T10:00', ZONE)
    expect(due).toEqual({ at: new Date('2026-10-27T05:00:00Z'), allDay: false })
  })

  it('reads a date as an all-day task at local midnight', () => {
    expect(parseLocalDue('2026-10-29', ZONE)).toEqual({ at: new Date('2026-10-28T19:00:00Z'), allDay: true })
  })

  it('respects an explicit offset', () => {
    expect(parseLocalDue('2026-10-27T10:00Z', ZONE)?.at).toEqual(new Date('2026-10-27T10:00:00Z'))
  })

  it('rejects garbage and impossible dates', () => {
    expect(parseLocalDue('tomorrow', ZONE)).toBeNull()
    expect(parseLocalDue('2026-02-30T10:00', ZONE)).toBeNull()
  })

  it('handles daylight saving time (London, clocks go forward 29 Mar 2026)', () => {
    expect(parseLocalDue('2026-03-28T09:00', 'Europe/London')?.at).toEqual(new Date('2026-03-28T09:00:00Z'))
    expect(parseLocalDue('2026-03-30T09:00', 'Europe/London')?.at).toEqual(new Date('2026-03-30T08:00:00Z'))
  })
})

describe('formatDue', () => {
  const now = MONDAY_9AM
  const at = (iso: string) => parseLocalDue(iso, ZONE)!.at

  it('uses friendly relative days', () => {
    expect(formatDue(at('2026-10-26T18:30'), false, ZONE, now)).toBe('today, 6:30 PM')
    expect(formatDue(at('2026-10-27T10:00'), false, ZONE, now)).toBe('tomorrow, 10:00 AM')
    expect(formatDue(at('2026-10-29'), true, ZONE, now)).toBe('Thursday')
    expect(formatDue(at('2026-11-10T09:00'), false, ZONE, now)).toBe('Tue 10 Nov, 9:00 AM')
    expect(formatDue(at('2027-01-04'), true, ZONE, now)).toBe('Mon 4 Jan 2027')
    expect(formatDue(at('2026-10-25T09:00'), false, ZONE, now)).toBe('yesterday, 9:00 AM')
  })

  it('round-trips through toLocalIso', () => {
    expect(toLocalIso(at('2026-10-27T10:00'), ZONE)).toBe('2026-10-27T10:00')
    expect(toLocalIso(at('2026-10-29'), ZONE, true)).toBe('2026-10-29')
  })
})

describe('ranges and overdue', () => {
  it('gives the local day as a UTC range', () => {
    const { from, to } = localDayRange(MONDAY_9AM, ZONE)
    expect(from).toEqual(new Date('2026-10-25T19:00:00Z'))
    expect(to).toEqual(new Date('2026-10-26T18:59:59.999Z'))
  })

  it('treats all-day tasks as overdue only after their day ends', () => {
    const today = parseLocalDue('2026-10-26', ZONE)!.at
    expect(isOverdue(today, true, ZONE, MONDAY_9AM)).toBe(false)
    expect(isOverdue(today, true, ZONE, new Date('2026-10-26T19:00:01Z'))).toBe(true)
    expect(isOverdue(new Date('2026-10-26T03:00:00Z'), false, ZONE, MONDAY_9AM)).toBe(true)
  })
})

describe('guessTimezone', () => {
  it('maps single-timezone countries', () => {
    expect(guessTimezone('923001234567')).toBe('Asia/Karachi')
    expect(guessTimezone('442071838750')).toBe('Europe/London')
    expect(guessTimezone('447911123456')).toBe('Europe/Guernsey')
  })
  it('returns null for multi-timezone countries or unknown input', () => {
    expect(guessTimezone('12025550123')).toBeNull()
    expect(guessTimezone(undefined)).toBeNull()
  })
})

describe('recurrence', () => {
  it('normalizes and validates rules', () => {
    expect(normalizeRecurrence('RRULE:FREQ=WEEKLY;BYDAY=MO')).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(normalizeRecurrence('FREQ=HOURLY')).toBeNull()
    expect(normalizeRecurrence('nonsense')).toBeNull()
  })

  it('finds the next weekly occurrence in local time', () => {
    const anchor = parseLocalDue('2026-10-26T09:00', ZONE)!.at
    const next = nextOccurrence('FREQ=WEEKLY;BYDAY=MO', anchor, ZONE, anchor)
    expect(toLocalIso(next!, ZONE)).toBe('2026-11-02T09:00')
  })

  it('keeps the wall-clock time across a DST change', () => {
    const anchor = parseLocalDue('2026-03-28T09:00', 'Europe/London')!.at
    const next = nextOccurrence('FREQ=DAILY', anchor, 'Europe/London', new Date('2026-03-29T12:00:00Z'))
    expect(toLocalIso(next!, 'Europe/London')).toBe('2026-03-30T09:00')
    expect(next).toEqual(new Date('2026-03-30T08:00:00Z'))
  })

  it('ends when the series ends', () => {
    const anchor = parseLocalDue('2026-10-26T09:00', ZONE)!.at
    expect(nextOccurrence('FREQ=DAILY;COUNT=1', anchor, ZONE, anchor)).toBeNull()
  })
})
