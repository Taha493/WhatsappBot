import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpApp, listen } from '../src/http/server.js'
import { createLogger } from '../src/lib/logger.js'
import { parseLocalDue } from '../src/tasks/time.js'
import { createTestApp, PHONE, ZONE } from './helpers.js'

let server: Server | undefined
afterEach(() => server?.close())

async function start(adminPassword?: string) {
  const ctx = await createTestApp()
  server = await listen(
    createHttpApp({ db: ctx.db, channel: ctx.channel, adminPassword, defaultTimezone: ZONE, logger: createLogger('silent') }),
    0,
  )
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { ctx, base }
}

const auth = (password: string) => ({ Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` })

describe('HTTP', () => {
  it('/health reports the channel status', async () => {
    const { ctx, base } = await start()
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, status: 'open' })
    ctx.channel.state = 'logged_out'
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, needsLink: true })
  })

  it('admin pages are disabled without a password', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/admin`)).status).toBe(404)
  })

  it('admin pages require the password', async () => {
    const { base } = await start('s3cret')
    expect((await fetch(`${base}/admin`)).status).toBe(401)
    expect((await fetch(`${base}/admin`, { headers: auth('wrong') })).status).toBe(401)
    expect((await fetch(`${base}/admin`, { headers: auth('s3cret') })).status).toBe(200)
  })

  it('renders users, tasks and conversations, escaping user content', async () => {
    const { ctx, base } = await start('s3cret')
    const { user } = await ctx.app.users.touch({ id: `${PHONE}@s.whatsapp.net`, phone: PHONE }, '<b>Taha</b>')
    await ctx.app.tasks.create(user.id, {
      title: 'Submit <script>alert(1)</script>',
      due: parseLocalDue('2026-10-27T10:00', ZONE)!,
      reminders: [{ minutesBefore: 0 }],
    })
    const list = await (await fetch(`${base}/admin/users`, { headers: auth('s3cret') })).text()
    expect(list).toContain('&lt;b&gt;Taha&lt;/b&gt;')
    expect(list).toContain('92300****567')

    const detail = await (await fetch(`${base}/admin/users/${user.id}`, { headers: auth('s3cret') })).text()
    expect(detail).toContain('Submit &lt;script&gt;')
    expect(detail).not.toContain('<script>alert')

    const reminders = await (await fetch(`${base}/admin/reminders`, { headers: auth('s3cret') })).text()
    expect(reminders).toContain('scheduled')
  })
})
