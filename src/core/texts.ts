import { DateTime } from 'luxon'
import { BOT_NAME } from '../ai/context.js'

export const texts = {
  welcome(name: string | null, zone: string, now: Date, timezoneKnown: boolean): string {
    const hello = name ? `👋 Hi ${name}!` : '👋 Hi!'
    const local = DateTime.fromJSDate(now, { zone }).toFormat('h:mm a')
    const tz = timezoneKnown
      ? `I've set your timezone to *${zone}* (it's ${local} there now). If that's wrong, just tell me your city.`
      : `Which city are you in? I'm using *${zone}* for now, and I need the right timezone to remind you on time.`
    return [
      `${hello} I'm ${BOT_NAME}, your personal task assistant on WhatsApp.`,
      '',
      'Just tell me what you need, for example:',
      '• _Remind me to submit my assignment tomorrow at 10 AM_',
      '• _What do I have to do this week?_',
      '• _Mark the assignment as completed_',
      '• Or send me a voice note 🎤',
      '',
      tz,
      '',
      'Type */help* any time to see everything I can do.',
    ].join('\n')
  },

  help: [
    `*${BOT_NAME} — your task assistant* 📋`,
    '',
    'Talk to me normally:',
    '• _Remind me to call mom at 6pm_',
    '• _Prepare the presentation by Thursday, high priority_',
    '• _Every Monday at 9 remind me to plan the week_',
    '• _Move the presentation to Friday_',
    '• _What\'s overdue?_ · _What did I finish last week?_',
    '• _Send me a daily summary at 8am_',
    '',
    'When a reminder arrives, *reply to it* with: *done*, *snooze 1h* or *tomorrow*.',
    '',
    '*Shortcuts*',
    '/today — today\'s tasks',
    '/week — the next 7 days',
    '/tasks — all open tasks',
    '/done 3 — complete task #3',
    '/undo — undo the last change',
    '/settings — timezone and daily summary',
    '/reset — delete all your data',
  ].join('\n'),

  rateLimited: "You're sending messages a bit fast 😅 Give me a few minutes and try again.",
  busy: "I'm a bit overloaded right now 😓 Please try again in a minute. (/today and /week still work.)",
  error: 'Sorry, something went wrong on my side. Please try again.',
  unsupported: 'I can read text and voice notes 🙂 Photos, stickers and files aren\'t supported yet.',
  voiceDisabled: "Voice notes aren't enabled on this bot yet. Please type your message instead.",
  voiceEmpty: "I couldn't make out anything in that voice note. Could you try again or type it?",
  resetConfirm:
    '⚠️ This permanently deletes *all* your tasks, reminders and history.\nSend */reset confirm* to continue.',
  resetDone: 'All your data has been deleted. Send me a message any time to start fresh 👋',
}

/** Greetings that need no further reply after the welcome message. */
export function isGreeting(text: string | undefined): boolean {
  if (!text) return true
  return /^(hi|hello|hey|hiya|yo|salam|salaam|assalam[ou]? ?alaikum|aoa|start|\/start|good (morning|afternoon|evening))[\s!.👋]*$/iu.test(
    text.trim(),
  )
}
