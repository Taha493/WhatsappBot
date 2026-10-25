import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const createdAt = () => tz('created_at').notNull().defaultNow()

export const priorityEnum = pgEnum('task_priority', ['low', 'normal', 'high'])
export const taskStatusEnum = pgEnum('task_status', ['open', 'done', 'deleted'])
export const reminderStatusEnum = pgEnum('reminder_status', [
  'scheduled',
  'sending',
  'sent',
  'failed',
  'cancelled',
])
export const eventTypeEnum = pgEnum('task_event_type', [
  'created',
  'updated',
  'completed',
  'reopened',
  'deleted',
  'restored',
])
export const directionEnum = pgEnum('message_direction', ['in', 'out'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** WhatsApp address as seen by the channel (phone JID or LID). */
  jid: text('jid').notNull().unique(),
  /** Digits only, international format, when known. */
  phone: text('phone'),
  name: text('name'),
  /** IANA timezone; null until known (DEFAULT_TIMEZONE is used meanwhile). */
  timezone: text('timezone'),
  onboardedAt: tz('onboarded_at'),
  digestEnabled: boolean('digest_enabled').notNull().default(false),
  /** Local time of day, "HH:MM:SS". */
  digestTime: time('digest_time'),
  lastDigestOn: date('last_digest_on', { mode: 'string' }),
  nextTaskNumber: integer('next_task_number').notNull().default(1),
  createdAt: createdAt(),
  lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
})

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Per-user number shown to the user and the LLM. */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    dueAt: tz('due_at'),
    allDay: boolean('all_day').notNull().default(false),
    priority: priorityEnum('priority').notNull().default('normal'),
    status: taskStatusEnum('status').notNull().default('open'),
    /** RRULE string (without DTSTART); the series is anchored on due_at. */
    recurrence: text('recurrence'),
    completedAt: tz('completed_at'),
    deletedAt: tz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tasks_user_number_idx').on(t.userId, t.number),
    index('tasks_user_status_due_idx').on(t.userId, t.status, t.dueAt),
  ],
)

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    remindAt: tz('remind_at').notNull(),
    /** Minutes before the task's due time, when the reminder is relative (follows due changes). */
    offsetMinutes: integer('offset_minutes'),
    status: reminderStatusEnum('status').notNull().default('scheduled'),
    attempts: integer('attempts').notNull().default(0),
    waMessageId: text('wa_message_id'),
    lastError: text('last_error'),
    claimedAt: tz('claimed_at'),
    sentAt: tz('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('reminders_due_idx').on(t.remindAt).where(sql`${t.status} = 'scheduled'`),
    index('reminders_wa_message_idx').on(t.waMessageId),
    index('reminders_task_idx').on(t.taskId),
  ],
)

export type TaskSnapshot = {
  title: string
  notes: string | null
  dueAt: string | null
  allDay: boolean
  priority: 'low' | 'normal' | 'high'
  status: 'open' | 'done' | 'deleted'
  recurrence: string | null
}

export type TaskEventMeta = {
  /** Reminders cancelled by this action (restored on undo). */
  cancelledReminderIds?: string[]
  /** Reminders created by this action (cancelled on undo). */
  createdReminderIds?: string[]
  /** Reminders moved because the due time changed (moved back on undo). */
  shiftedReminderIds?: string[]
  shiftMs?: number
  /** For recurring completions: the occurrence that was completed. */
  occurrenceDueAt?: string
}

export const taskEvents = pgTable(
  'task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Strict insertion order (several events can share a timestamp). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: eventTypeEnum('type').notNull(),
    before: jsonb('before').$type<TaskSnapshot>(),
    after: jsonb('after').$type<TaskSnapshot>(),
    meta: jsonb('meta').$type<TaskEventMeta>(),
    undoneAt: tz('undone_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('task_events_user_seq_idx').on(t.userId, t.seq),
    index('task_events_user_created_idx').on(t.userId, t.createdAt),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Strict insertion order (an incoming message and its reply can share a timestamp). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    waMessageId: text('wa_message_id').unique(),
    direction: directionEnum('direction').notNull(),
    type: text('type').notNull(),
    content: text('content'),
    toolCalls: jsonb('tool_calls').$type<unknown[]>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_user_seq_idx').on(t.userId, t.seq)],
)

/** Baileys session: credentials + signal keys, serialized with BufferJSON. */
export const waAuth = pgTable('wa_auth', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Reminder = typeof reminders.$inferSelect
export type TaskEvent = typeof taskEvents.$inferSelect
export type Message = typeof messages.$inferSelect
