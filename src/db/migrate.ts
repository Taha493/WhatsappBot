import { openDatabase } from './client.js'

// Migrations also run automatically on startup; this script is for running them on their own.
const handle = await openDatabase(process.env.DATABASE_URL?.trim() || undefined)
console.log(`Migrations applied (${handle.kind}).`)
await handle.close()
