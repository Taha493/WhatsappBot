import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import express, { type NextFunction, type Request, type Response } from 'express'
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import QRCode from 'qrcode'
import type { Channel } from '../channels/types.js'
import type { Db } from '../db/client.js'
import { messages, reminders, tasks, users } from '../db/schema.js'
import { maskId, type Logger } from '../lib/logger.js'
import { formatDue } from '../tasks/time.js'
import { html, page, raw } from './html.js'

type Deps = {
  db: Db
  channel: Channel
  adminPassword?: string
  defaultTimezone: string
  logger: Logger
}

/** Health check, device-linking page and a read-only admin dashboard (HTTP Basic auth). */
export function createHttpApp({ db, channel, adminPassword, defaultTimezone }: Deps) {
  const app = express()
  app.disable('x-powered-by')
  const startedAt = Date.now()

  app.get('/health', (_req, res) => {
    const status = channel.status()
    res.status(status === 'logged_out' ? 503 : 200).json({
      ok: status === 'open',
      channel: channel.name,
      status,
      needsLink: status === 'logged_out' || channel.linkInfo() !== null,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    })
  })

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!adminPassword) {
      res.status(404).send('Admin pages are disabled. Set ADMIN_PASSWORD in .env to enable them.')
      return
    }
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ')
    const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : ''
    const a = Buffer.from(password)
    const b = Buffer.from(adminPassword)
    if (a.length === b.length && timingSafeEqual(a, b)) return next()
    res.setHeader('WWW-Authenticate', 'Basic realm="Remi admin", charset="UTF-8"')
    res.status(401).send('Authentication required (user: admin)')
  }

  app.get('/', (_req, res) => res.redirect('/admin'))

  app.get('/link', requireAdmin, async (_req, res) => {
    const link = channel.linkInfo()
    const status = channel.status()
    let body
    if (status === 'open') {
      body = html`<div class="center"><h1 class="ok">✅ WhatsApp is connected</h1><p class="muted">Nothing to do here.</p></div>`
    } else if (link?.method === 'qr') {
      const svg = await QRCode.toString(link.qr, { type: 'svg', margin: 1 })
      body = html`<div class="center"><h1>Link the bot number</h1>${raw(svg)}
        <p>On the bot phone: WhatsApp → <b>Linked devices</b> → <b>Link a device</b> → scan.</p>
        <p class="muted">The code refreshes automatically.</p></div>`
    } else if (link?.method === 'pairing') {
      body = html`<div class="center"><h1>Link the bot number</h1><p class="code">${link.code}</p>
        <p>On the bot phone: WhatsApp → <b>Linked devices</b> → <b>Link a device</b> → <b>Link with phone number instead</b> → enter the code.</p></div>`
    } else {
      body = html`<div class="center"><h1>Connecting…</h1><p class="muted">Status: ${status}</p></div>`
    }
    res.send(page('Link device', body, { refreshSeconds: status === 'open' ? undefined : 5 }))
  })

  app.get('/admin', requireAdmin, async (_req, res) => {
    const now = new Date()
    const dayAgo = new Date(now.getTime() - 86_400_000)
    const [[u], [open], [scheduled], [sent], [failed], [msgs]] = await Promise.all([
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(tasks).where(eq(tasks.status, 'open')),
      db.select({ n: count() }).from(reminders).where(eq(reminders.status, 'scheduled')),
      db.select({ n: count() }).from(reminders).where(and(eq(reminders.status, 'sent'), gte(reminders.sentAt, dayAgo))),
      db.select({ n: count() }).from(reminders).where(eq(reminders.status, 'failed')),
      db.select({ n: count() }).from(messages).where(gte(messages.createdAt, dayAgo)),
    ])
    const upcoming = await reminderRows(db, sql`${reminders.status} = 'scheduled'`, 'asc', 10)
    const status = channel.status()
    const body = html`<h1>Overview</h1>
      <div class="cards">
        ${card('WhatsApp', raw(`<span class="${status === 'open' ? 'ok' : 'bad'}">${status}</span>`))}
        ${card('Users', u?.n)}${card('Open tasks', open?.n)}${card('Scheduled reminders', scheduled?.n)}
        ${card('Reminders sent (24h)', sent?.n)}${card('Failed reminders', failed?.n)}${card('Messages (24h)', msgs?.n)}
      </div>
      <h2>Next reminders</h2>${reminderTable(upcoming, defaultTimezone, now)}`
    res.send(page('Overview', body, { refreshSeconds: 30 }))
  })

  app.get('/admin/users', requireAdmin, async (_req, res) => {
    const rows = await db
      .select({
        user: users,
        open: sql<number>`(select count(*)::int from ${tasks} where ${tasks.userId} = ${users.id} and ${tasks.status} = 'open')`,
      })
      .from(users)
      .orderBy(desc(users.lastSeenAt))
      .limit(200)
    const body = html`<h1>Users (${rows.length})</h1><div class="table-wrap"><table>
      <tr><th>Name</th><th>Number</th><th>Timezone</th><th>Open tasks</th><th>Daily summary</th><th>Last seen</th></tr>
      ${rows.map(
        ({ user, open }) => html`<tr>
          <td><a href="/admin/users/${user.id}">${user.name ?? '(no name)'}</a></td>
          <td>${maskId(user.phone ?? user.jid)}</td><td>${user.timezone ?? `${defaultTimezone} (default)`}</td>
          <td>${open}</td><td>${user.digestEnabled ? user.digestTime?.slice(0, 5) : '—'}</td>
          <td>${user.lastSeenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</td></tr>`,
      )}</table></div>`
    res.send(page('Users', body))
  })

  app.get('/admin/users/:id', requireAdmin, async (req, res) => {
    const id = String(req.params.id)
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.status(404).send('Not found')
      return
    }
    const [user] = await db.select().from(users).where(eq(users.id, id))
    if (!user) {
      res.status(404).send('Not found')
      return
    }
    const zone = user.timezone ?? defaultTimezone
    const now = new Date()
    const [taskRows, msgRows] = await Promise.all([
      db.select().from(tasks).where(eq(tasks.userId, id)).orderBy(sql`${tasks.status} = 'open' desc`, sql`${tasks.dueAt} asc nulls last`).limit(200),
      db.select().from(messages).where(eq(messages.userId, id)).orderBy(desc(messages.seq)).limit(60),
    ])
    const body = html`<h1>${user.name ?? '(no name)'} <span class="muted">${maskId(user.phone ?? user.jid)} · ${zone}</span></h1>
      <h2>Tasks (${taskRows.length})</h2><div class="table-wrap"><table>
      <tr><th>#</th><th>Title</th><th>Due</th><th>Status</th><th>Repeats</th></tr>
      ${taskRows.map(
        (t) => html`<tr><td>${t.number}</td><td>${t.title}${t.notes ? html`<div class="muted">${t.notes}</div>` : ''}</td>
          <td>${t.dueAt ? formatDue(t.dueAt, t.allDay, zone, now) : '—'}</td>
          <td><span class="badge">${t.status}</span></td><td>${t.recurrence ?? ''}</td></tr>`,
      )}</table></div>
      <h2>Recent conversation</h2><div class="table-wrap"><table>
      <tr><th></th><th>Message</th><th>When (UTC)</th></tr>
      ${msgRows.map(
        (m) => html`<tr class="${m.direction === 'in' ? 'msg-in' : ''}"><td>${m.direction === 'in' ? '👤' : '🤖'}</td>
          <td><pre>${m.content ?? `(${m.type})`}</pre>
          ${m.toolCalls ? html`<details><summary class="muted">${m.toolCalls.length} tool call(s)</summary><pre>${JSON.stringify(m.toolCalls, null, 2)}</pre></details>` : ''}
          ${m.error ? html`<div class="bad muted">${m.error}</div>` : ''}</td>
          <td class="muted">${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`,
      )}</table></div>`
    res.send(page(user.name ?? 'User', body))
  })

  app.get('/admin/reminders', requireAdmin, async (_req, res) => {
    const rows = await reminderRows(db, sql`true`, 'desc', 100)
    res.send(page('Reminders', html`<h1>Reminders (latest 100)</h1>${reminderTable(rows, defaultTimezone, new Date())}`))
  })

  return app
}

function card(label: string, value: unknown) {
  return html`<div class="card"><span class="muted">${label}</span><b>${value as string}</b></div>`
}

function reminderRows(db: Db, where: ReturnType<typeof sql>, order: 'asc' | 'desc', limit: number) {
  return db
    .select({ reminder: reminders, title: tasks.title, number: tasks.number, user: users.name, zone: users.timezone })
    .from(reminders)
    .innerJoin(tasks, eq(tasks.id, reminders.taskId))
    .innerJoin(users, eq(users.id, reminders.userId))
    .where(where)
    .orderBy(order === 'asc' ? reminders.remindAt : desc(reminders.remindAt))
    .limit(limit)
}

function reminderTable(rows: Awaited<ReturnType<typeof reminderRows>>, defaultZone: string, now: Date) {
  if (rows.length === 0) return html`<p class="muted">None.</p>`
  return html`<div class="table-wrap"><table>
    <tr><th>When</th><th>User</th><th>Task</th><th>Status</th><th>Attempts</th><th>Error</th></tr>
    ${rows.map(
      (r) => html`<tr><td>${formatDue(r.reminder.remindAt, false, r.zone ?? defaultZone, now)}</td><td>${r.user ?? '—'}</td>
        <td>#${r.number} ${r.title}</td>
        <td><span class="badge ${r.reminder.status === 'failed' ? 'bad' : r.reminder.status === 'sent' ? 'ok' : ''}">${r.reminder.status}</span></td>
        <td>${r.reminder.attempts}</td><td class="muted">${r.reminder.lastError ?? ''}</td></tr>`,
    )}</table></div>`
}

export function listen(app: ReturnType<typeof createHttpApp>, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server))
  })
}
