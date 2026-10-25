import { DateTime } from 'luxon'
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import rrulePkg from 'rrule'

const { RRule, Frequency } = rrulePkg

export type Clock = () => Date
export const systemClock: Clock = () => new Date()

export type ParsedDue = { at: Date; allDay: boolean }

export function isValidTimezone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * Parses a local date ("2026-10-27") or local datetime ("2026-10-27T10:00") in the
 * user's timezone. An explicit offset is respected. Returns null when invalid.
 */
export function parseLocalDue(input: string, zone: string): ParsedDue | null {
  const value = input.trim()
  if (DATE_ONLY.test(value)) {
    const dt = DateTime.fromISO(value, { zone })
    return dt.isValid ? { at: dt.startOf('day').toJSDate(), allDay: true } : null
  }
  if (DATE_TIME.test(value)) {
    const dt = DateTime.fromISO(value.replace(' ', 'T'), { zone })
    return dt.isValid ? { at: dt.toJSDate(), allDay: false } : null
  }
  return null
}

/** Start (or end) of a local calendar date, as a UTC instant. */
export function parseLocalDate(input: string, zone: string, edge: 'start' | 'end'): Date | null {
  if (!DATE_ONLY.test(input.trim())) return null
  const dt = DateTime.fromISO(input.trim(), { zone })
  if (!dt.isValid) return null
  return (edge === 'start' ? dt.startOf('day') : dt.endOf('day')).toJSDate()
}

/** "2026-10-27T10:00" (or "2026-10-27" for all-day) in the user's timezone, for the LLM. */
export function toLocalIso(date: Date, zone: string, allDay = false): string {
  const dt = DateTime.fromJSDate(date, { zone })
  return allDay ? dt.toFormat('yyyy-MM-dd') : dt.toFormat("yyyy-MM-dd'T'HH:mm")
}

/** "today, 10:00 AM" · "tomorrow" · "Thursday, 9:00 AM" · "Tue 3 Nov" · "Mon 4 Jan 2027, 8:30 AM" */
export function formatDue(date: Date, allDay: boolean, zone: string, now: Date): string {
  const dt = DateTime.fromJSDate(date, { zone })
  const today = DateTime.fromJSDate(now, { zone }).startOf('day')
  const days = Math.round(dt.startOf('day').diff(today, 'days').days)

  let day: string
  if (days === 0) day = 'today'
  else if (days === 1) day = 'tomorrow'
  else if (days === -1) day = 'yesterday'
  else if (days > 1 && days < 7) day = dt.toFormat('cccc')
  else if (dt.year === today.year) day = dt.toFormat('ccc d LLL')
  else day = dt.toFormat('ccc d LLL yyyy')

  return allDay ? day : `${day}, ${dt.toFormat('h:mm a')}`
}

/** Human description of "now" for the system prompt. */
export function describeNow(now: Date, zone: string): string {
  return DateTime.fromJSDate(now, { zone }).toFormat("cccc, d LLLL yyyy, HH:mm '('ZZZZ')'")
}

export function localDayRange(now: Date, zone: string, offsetDays = 0, lengthDays = 1) {
  const start = DateTime.fromJSDate(now, { zone }).startOf('day').plus({ days: offsetDays })
  return {
    from: start.toJSDate(),
    to: start.plus({ days: lengthDays }).minus({ milliseconds: 1 }).toJSDate(),
  }
}

export function isOverdue(due: Date, allDay: boolean, zone: string, now: Date): boolean {
  if (!allDay) return due.getTime() < now.getTime()
  return DateTime.fromJSDate(due, { zone }).endOf('day').toMillis() < now.getTime()
}

// ── Timezone guess from phone number ───────────────────────────────────

/** Countries that use a single timezone. Multi-zone countries (US, CA, AU, BR, RU, MX, ID…) are omitted on purpose. */
const COUNTRY_TIMEZONES: Record<string, string> = {
  PK: 'Asia/Karachi', IN: 'Asia/Kolkata', BD: 'Asia/Dhaka', LK: 'Asia/Colombo',
  NP: 'Asia/Kathmandu', AF: 'Asia/Kabul', IR: 'Asia/Tehran', AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh', QA: 'Asia/Qatar', KW: 'Asia/Kuwait', BH: 'Asia/Bahrain',
  OM: 'Asia/Muscat', JO: 'Asia/Amman', LB: 'Asia/Beirut', IQ: 'Asia/Baghdad',
  TR: 'Europe/Istanbul', EG: 'Africa/Cairo', MA: 'Africa/Casablanca', NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi', GH: 'Africa/Accra', ZA: 'Africa/Johannesburg', ET: 'Africa/Addis_Ababa',
  GB: 'Europe/London', GG: 'Europe/Guernsey', JE: 'Europe/Jersey', IM: 'Europe/Isle_of_Man',
  IE: 'Europe/Dublin', PT: 'Europe/Lisbon', ES: 'Europe/Madrid',
  FR: 'Europe/Paris', DE: 'Europe/Berlin', IT: 'Europe/Rome', NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels', CH: 'Europe/Zurich', AT: 'Europe/Vienna', PL: 'Europe/Warsaw',
  SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki',
  GR: 'Europe/Athens', RO: 'Europe/Bucharest', UA: 'Europe/Kyiv', CN: 'Asia/Shanghai',
  HK: 'Asia/Hong_Kong', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur', TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh', PH: 'Asia/Manila', JP: 'Asia/Tokyo', KR: 'Asia/Seoul',
  NZ: 'Pacific/Auckland', AR: 'America/Argentina/Buenos_Aires', CO: 'America/Bogota',
  PE: 'America/Lima', CL: 'America/Santiago',
}

/** Best-effort timezone from an international phone number (digits only). */
export function guessTimezone(phoneDigits: string | null | undefined): string | null {
  if (!phoneDigits) return null
  const country = parsePhoneNumberFromString('+' + phoneDigits)?.country
  return (country && COUNTRY_TIMEZONES[country]) ?? null
}

// ── Recurrence (RRULE) ────────────────────────────────────────────────

const ALLOWED_FREQUENCIES = new Set([
  Frequency.DAILY,
  Frequency.WEEKLY,
  Frequency.MONTHLY,
  Frequency.YEARLY,
])

/**
 * Normalizes an RRULE ("FREQ=WEEKLY;BYDAY=MO", optionally prefixed "RRULE:").
 * Only daily or slower rules are allowed. Returns null when invalid.
 */
export function normalizeRecurrence(input: string): string | null {
  const body = input.trim().replace(/^RRULE:/i, '')
  if (!body || /DTSTART/i.test(body)) return null
  try {
    const options = RRule.parseString(body)
    if (options.freq === undefined || !ALLOWED_FREQUENCIES.has(options.freq)) return null
    return RRule.optionsToString(options).replace(/^RRULE:/, '')
  } catch {
    return null
  }
}

/** Shift a real instant to a "floating" Date whose UTC fields equal the local wall time. */
function toFloating(date: Date, zone: string): Date {
  const dt = DateTime.fromJSDate(date, { zone })
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second))
}

function fromFloating(date: Date, zone: string): Date {
  return DateTime.fromObject(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    },
    { zone },
  ).toJSDate()
}

/**
 * Next occurrence of a series anchored at `anchor`, strictly after `after`.
 * Works in local wall time so "every day at 9:00" stays 9:00 across DST changes.
 */
export function nextOccurrence(
  rule: string,
  anchor: Date,
  zone: string,
  after: Date,
): Date | null {
  const options = RRule.parseString(rule)
  const series = new RRule({ ...options, dtstart: toFloating(anchor, zone) })
  const next = series.after(toFloating(after, zone), false)
  return next ? fromFloating(next, zone) : null
}

/** "every week on Monday" — for messages. */
export function describeRecurrence(rule: string): string {
  try {
    return RRule.fromString(rule).toText()
  } catch {
    return rule
  }
}
