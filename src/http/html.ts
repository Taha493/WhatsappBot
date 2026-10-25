const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!)

/** Tagged template that escapes interpolations, except values wrapped with raw(). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]!
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1]
  })
  return new Raw(out)
}

export class Raw {
  constructor(readonly value: string) {}
  toString() {
    return this.value
  }
}

export const raw = (value: string) => new Raw(value)

function render(value: unknown): string {
  if (value instanceof Raw) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || value === false) return ''
  return escape(value)
}

export function page(title: string, body: Raw, opts: { refreshSeconds?: number } = {}): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refreshSeconds ? raw(`<meta http-equiv="refresh" content="${opts.refreshSeconds}">`) : ''}
<title>${title} · Remi admin</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --text:#1c1f24; --muted:#6b7280; --line:#e5e7eb; --accent:#128c7e; --bad:#c2410c; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --text:#e6e8eb; --muted:#9aa1ab; --line:#2a2f37; --accent:#25d366; --bad:#fb923c; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; gap:20px; align-items:center; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--card); flex-wrap:wrap; }
header strong { color:var(--accent); }
header a { color:var(--text); text-decoration:none; }
main { max-width:1100px; margin:0 auto; padding:20px 16px; }
h1 { font-size:22px; margin:0 0 16px; } h2 { font-size:17px; margin:28px 0 10px; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
.card b { display:block; font-size:24px; }
.muted { color:var(--muted); font-size:13px; }
.table-wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
tr:last-child td { border-bottom:0; }
.badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; border:1px solid var(--line); }
.ok { color:var(--accent); } .bad { color:var(--bad); }
.msg-in td:first-child { color:var(--accent); }
pre { white-space:pre-wrap; margin:6px 0 0; font-size:12px; }
.center { text-align:center; padding:40px 0; } .center svg { width:280px; height:280px; background:#fff; padding:12px; border-radius:12px; }
.code { font:600 36px/1 ui-monospace, monospace; letter-spacing:.2em; }
a { color:var(--accent); }
</style>
</head>
<body>
<header><strong>⏰ Remi admin</strong><a href="/admin">Overview</a><a href="/admin/users">Users</a><a href="/admin/reminders">Reminders</a><a href="/link">Link device</a></header>
<main>${body}</main>
</body>
</html>`.value
}
