// The schema rail (v2 SPEC 13.11.2; cbundy/dev-system#888): the loop acts only on a factory
// database whose schema this image's startup migrate (factory-db-migrate, run by dev-init) brought
// up to date. The migrate writes its outcome to a status file; this rail reads it through the
// rails' io. A missing file passes (no migrator is set up here, nothing to wait for), as do
// `migrated` and `current`. `failed` and `timed-out` hold the loop in observe and tell the owner
// once per startup (the tell is keyed by the status's `at`). `running` holds it without a tell
// while it is young, and with one once it is older than the migrate's own bound could explain, or
// when the file cannot be read: every doubt keeps the loop in observe.
import type { RailIo } from './rails'
import type { Ms } from './types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
export const MIGRATE_STATUS_DEFAULT = '/tmp/dev-factory-db-migrate.json'
// The migrate is bounded to 120 s (DEV_FACTORY_DB_MIGRATE_TIMEOUT); a `running` record this old was
// left by a crashed startup.
export const MIGRATE_RUNNING_MS = 10 * MINUTE

export type SchemaNotice = { kind: 'schema-behind'; since: Ms; to: string; error: string }
export type SchemaVerdict = { reason: string | null; notice: SchemaNotice | null }

export type SchemaEnv = { DEV_FACTORY_DB_MIGRATE_STATUS?: string }

const PASS: SchemaVerdict = { reason: null, notice: null }

function versionOf(v: unknown): string {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v) : '?'
}

function atOf(v: unknown): Ms | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

// schemaRail: one file read per pass.
export async function schemaRail(io: RailIo, env: SchemaEnv, now: Ms): Promise<SchemaVerdict> {
  const path = env.DEV_FACTORY_DB_MIGRATE_STATUS || MIGRATE_STATUS_DEFAULT
  let text: string | null
  try {
    text = await io.readFile(path)
  } catch {
    text = ''
  }
  if (text === null) return PASS

  // A doubt about the file: refuse, and tell once an hour while it lasts.
  const doubt = (why: string, at: Ms | null): SchemaVerdict => {
    const since = at ?? Math.floor(now / HOUR) * HOUR
    return {
      reason: `schema: ${why}`,
      notice: { kind: 'schema-behind', since, to: '?', error: why },
    }
  }

  let o: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(text)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doubt(`${path} is not a migrate status`, null)
    o = raw as Record<string, unknown>
  } catch {
    return doubt(`${path} cannot be read as a migrate status`, null)
  }

  switch (o.outcome) {
    case 'migrated':
    case 'current':
      return PASS
    case 'running': {
      const at = atOf(o.at)
      if (at !== null && now - at < MIGRATE_RUNNING_MS) return { reason: `schema: the startup migrate is running (since ${new Date(at).toISOString()})`, notice: null }
      return doubt(`the startup migrate has been running since ${at === null ? 'an unknown time' : new Date(at).toISOString()}, longer than its bound`, at)
    }
    case 'failed':
    case 'timed-out': {
      const to = versionOf(o.to_version)
      const error = typeof o.error === 'string' && o.error !== '' ? o.error : String(o.outcome)
      const at = atOf(o.at)
      return {
        reason: `schema: migrate to ${to} failed: ${error}`,
        notice: { kind: 'schema-behind', since: at ?? Math.floor(now / HOUR) * HOUR, to, error },
      }
    }
    default:
      return doubt(`${path} has no known migrate outcome`, atOf(o.at))
  }
}
