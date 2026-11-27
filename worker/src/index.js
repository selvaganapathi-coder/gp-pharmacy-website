import bcrypt from 'bcryptjs'
import { sanitizeDeep } from '../../server/sanitize.js'

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const JWT_TTL_SECONDS = 4 * 60 * 60

const ALLOWED_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

function b64urlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let str = ''
  for (let i = 0; i < bytes.length; i += 1) str += String.fromCharCode(bytes[i])
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4)
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function getJwtSecret(env) {
  return (env.JWT_SECRET && env.JWT_SECRET.trim()) || 'gp-cms-worker-fallback-secret-change-in-prod'
}

async function signJwt(payload, secret) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64urlEncode(JSON.stringify({ ...payload, iat: now, exp: now + JWT_TTL_SECONDS }))
  const data = `${header}.${body}`
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return `${data}.${b64urlEncode(sig)}`
}

async function verifyJwt(token, secret) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const key = await importHmacKey(secret)
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(sig),
    new TextEncoder().encode(`${header}.${body}`),
  )
  if (!valid) return null
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
  return payload
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return { error: json({ error: 'Authentication required.' }, 401) }
  try {
    const user = await verifyJwt(token, getJwtSecret(env))
    if (!user?.sub || !user?.role) {
      return { error: json({ error: 'Invalid session.' }, 401) }
    }
    return { user }
  } catch {
    return { error: json({ error: 'Session expired. Please sign in again.' }, 401) }
  }
}

function getPublicContent(store) {
  const copy = structuredClone(store)
  delete copy.users
  delete copy.enquiries
  delete copy.activityLog
  delete copy.cmsDraft
  for (const key of ['notices', 'events', 'news', 'achievements', 'gallery', 'media']) {
    copy[key] = (copy[key] || []).filter((item) => item?.published !== false)
  }
  return copy
}

function appendActivity(store, entry) {
  const log = Array.isArray(store.activityLog) ? store.activityLog : []
  log.unshift({ id: `log-${Date.now()}`, at: new Date().toISOString(), ...entry })
  store.activityLog = log.slice(0, 100)
}

async function ensureSchema(db) {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS cms_store (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)',
    )
    .run()
}

async function loadStore(env) {
  await ensureSchema(env.DB)
  const row = await env.DB.prepare('SELECT data FROM cms_store WHERE id = ?').bind('main').first()
  if (row?.data) {
    return JSON.parse(row.data)
  }
  const now = new Date().toISOString()
  const adminPass = env.CMS_ADMIN_PASSWORD || 'gpadmin2026'
  const editorPass = env.CMS_EDITOR_PASSWORD || 'editor2026'
  const initial = {
    version: 1,
    updatedAt: now,
    users: [
      {
        id: 'user-admin',
        name: 'GP Admin',
        email: 'admin@gppharmacycollege.com',
        passwordHash: await bcrypt.hash(adminPass, 10),
        role: 'admin',
        active: true,
        createdAt: '2026-01-01',
      },
      {
        id: 'user-editor',
        name: 'Content Editor',
        email: 'editor@gppharmacycollege.com',
        passwordHash: await bcrypt.hash(editorPass, 10),
        role: 'editor',
        active: true,
        createdAt: '2026-01-01',
      },
    ],
    site: { name: 'G.P. Pharmacy College', code: '889' },
    website: { homepage: { published: true } },
    notices: [],
    events: [],
    news: [],
    placements: {},
    research: {},
    gallery: [],
    media: [],
    achievements: [],
    enquiries: [],
    activityLog: [],
    cmsDraft: null,
  }
  await saveStore(env, initial)
  return initial
}

async function saveStore(env, store) {
  store.updatedAt = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO cms_store (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  )
    .bind('main', JSON.stringify(store), store.updatedAt)
    .run()
  return store
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '600',
  }
}

function withCors(response, request) {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    headers.set(k, v)
  }
  return new Response(response.body, { status: response.status, headers })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    try {
      if (pathname === '/api/health' && request.method === 'GET') {
        const store = await loadStore(env)
        return withCors(json({ ok: true, updatedAt: store.updatedAt }), request)
      }

      if (pathname === '/api/content/public' && request.method === 'GET') {
        const store = await loadStore(env)
        return withCors(json(getPublicContent(store)), request)
      }

      if (pathname === '/api/content' && request.method === 'GET') {
        const auth = await requireAuth(request, env)
        if (auth.error) return withCors(auth.error, request)
        const store = await loadStore(env)
        const copy = structuredClone(store)
        copy.users = (copy.users || []).map(({ passwordHash: _ph, ...user }) => user)
        return withCors(json(copy), request)
      }

      if (pathname === '/api/content' && request.method === 'PUT') {
        const auth = await requireAuth(request, env)
        if (auth.error) return withCors(auth.error, request)
        const body = await request.json().catch(() => null)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return withCors(json({ error: 'Invalid content payload.' }, 400), request)
        }

        let store = await loadStore(env)
        const cleaned = sanitizeDeep(body)
        const incomingUsers = cleaned.users
        const publishMode = cleaned._publishMode === 'draft' ? 'draft' : 'publish'
        delete cleaned._publishMode

        const next = {
          ...store,
          ...cleaned,
          users: store.users,
          enquiries: Array.isArray(cleaned.enquiries) ? cleaned.enquiries : store.enquiries,
          activityLog: store.activityLog,
        }

        if (Array.isArray(incomingUsers) && auth.user.role === 'admin') {
          next.users = incomingUsers.map((user) => {
            const existing = store.users.find((item) => item.id === user.id)
            const { passwordHash: _ignored, password: _pw, ...safeUser } = user || {}
            return existing?.passwordHash ? { ...safeUser, passwordHash: existing.passwordHash } : safeUser
          })
        }

        if (publishMode === 'draft') {
          const { users: _u, enquiries: _e, activityLog: _a, cmsDraft: _d, ...draftBody } = { ...next }
          Object.assign(next, {
            site: store.site,
            website: store.website,
            admissions: store.admissions,
            notices: store.notices,
            events: store.events,
            news: store.news,
            placements: store.placements,
            research: store.research,
            gallery: store.gallery,
            media: store.media,
            achievements: store.achievements,
            activityLog: store.activityLog,
            enquiries: store.enquiries,
            users: store.users,
          })
          next.cmsDraft = draftBody
          appendActivity(next, {
            action: 'draft_saved',
            by: auth.user.email || auth.user.name || 'admin',
            note: 'Draft saved — not live on website',
          })
        } else {
          next.cmsDraft = null
          appendActivity(next, {
            action: 'published',
            by: auth.user.email || auth.user.name || 'admin',
            note: `Published · code ${next.site?.code || '—'} · ${next.site?.phoneDisplay || ''}`,
          })
        }

        store = await saveStore(env, next)
        return withCors(
          json({
            ok: true,
            updatedAt: store.updatedAt,
            mode: publishMode,
            hasDraft: Boolean(store.cmsDraft),
          }),
          request,
        )
      }

      if (pathname === '/api/enquiries' && request.method === 'POST') {
        const body = sanitizeDeep((await request.json().catch(() => ({}))) || {})
        const name = String(body.name || '').trim().slice(0, 120)
        const phone = String(body.phone || '').trim().slice(0, 40)
        if (!name || !phone) {
          return withCors(json({ error: 'Name and phone are required.' }, 400), request)
        }
        const item = {
          id: `enq-${Date.now()}`,
          name,
          phone,
          email: String(body.email || '').trim().slice(0, 120),
          course: String(body.course || '').trim().slice(0, 80),
          message: String(body.message || '').trim().slice(0, 2000) || '—',
          status: 'new',
          createdAt: new Date().toISOString(),
        }
        const store = await loadStore(env)
        store.enquiries = [item, ...(store.enquiries || [])].slice(0, 500)
        await saveStore(env, store)
        return withCors(json({ ok: true, id: item.id }), request)
      }

      if (pathname.startsWith('/api/enquiries/') && request.method === 'PATCH') {
        const auth = await requireAuth(request, env)
        if (auth.error) return withCors(auth.error, request)
        const id = decodeURIComponent(pathname.slice('/api/enquiries/'.length))
        const body = await request.json().catch(() => ({}))
        const status = String(body?.status || '').trim()
        if (!['new', 'read', 'replied', 'archived'].includes(status)) {
          return withCors(json({ error: 'Invalid status.' }, 400), request)
        }
        const store = await loadStore(env)
        const list = store.enquiries || []
        const idx = list.findIndex((e) => e.id === id)
        if (idx < 0) return withCors(json({ error: 'Enquiry not found.' }, 404), request)
        list[idx] = { ...list[idx], status, updatedAt: new Date().toISOString() }
        store.enquiries = list
        appendActivity(store, {
          action: 'enquiry_updated',
          by: auth.user.email || 'admin',
          note: `${id} → ${status}`,
        })
        await saveStore(env, store)
        return withCors(json({ ok: true, enquiry: list[idx] }), request)
      }

      if (pathname === '/api/auth/login' && request.method === 'POST') {
        const { email, password } = (await request.json().catch(() => ({}))) || {}
        if (!email || !password) {
          return withCors(json({ error: 'Email and password are required.' }, 400), request)
        }
        const store = await loadStore(env)
        const normalized = String(email).trim().toLowerCase()
        const user = (store.users || []).find(
          (u) => String(u.email || '').toLowerCase() === normalized && u.active,
        )
        const valid =
          user?.passwordHash &&
          typeof password === 'string' &&
          password.length >= 6 &&
          password.length <= 200 &&
          (await bcrypt.compare(password, user.passwordHash))

        if (!valid) {
          return withCors(json({ error: 'Invalid email or password.' }, 401), request)
        }
        const token = await signJwt(
          { sub: user.id, email: user.email, role: user.role, name: user.name },
          getJwtSecret(env),
        )
        return withCors(
          json({
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
          }),
          request,
        )
      }

      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        const auth = await requireAuth(request, env)
        if (auth.error) return withCors(auth.error, request)
        return withCors(json({ ok: true }), request)
      }

      if (pathname === '/api/upload' && request.method === 'POST') {
        const auth = await requireAuth(request, env)
        if (auth.error) return withCors(auth.error, request)
        if (!env.UPLOADS) {
          return withCors(json({ error: 'R2 bucket (UPLOADS) is not configured yet.' }, 503), request)
        }
        const formData = await request.formData().catch(() => null)
        const file = formData?.get('file')
        if (!file || typeof file === 'string') {
          return withCors(json({ error: 'No file uploaded.' }, 400), request)
        }
        if (!file.type?.startsWith('image/')) {
          return withCors(json({ error: 'Only image files are allowed.' }, 400), request)
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return withCors(json({ error: 'File exceeds 5 MB limit.' }, 400), request)
        }

        const ext = ALLOWED_EXT[file.type] || '.bin'
        const safeBase = String(file.name || 'upload')
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9_-]/g, '-')
          .slice(0, 40)
        const key = `${Date.now()}-${safeBase || 'img'}-${crypto.randomUUID().slice(0, 8)}${ext}`

        await env.UPLOADS.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type },
        })

        const uploadUrl = `/uploads/${key}`
        const mediaItem = {
          id: `media-${Date.now()}`,
          url: uploadUrl,
          name: String(file.name || 'upload').slice(0, 120),
          published: true,
          createdAt: new Date().toISOString(),
        }
        const store = await loadStore(env)
        store.media = [mediaItem, ...(store.media || [])].slice(0, 300)
        appendActivity(store, {
          action: 'upload',
          by: auth.user.email || 'admin',
          note: mediaItem.name,
        })
        await saveStore(env, store)
        return withCors(json({ url: uploadUrl, media: mediaItem }), request)
      }

      if (pathname.startsWith('/uploads/') && request.method === 'GET') {
        if (!env.UPLOADS) return json({ error: 'Not found' }, 404)
        const key = decodeURIComponent(pathname.slice('/uploads/'.length))
        if (!key || key.includes('..') || key.includes('/')) {
          return json({ error: 'Not found' }, 404)
        }
        const object = await env.UPLOADS.get(key)
        if (!object) return json({ error: 'Not found' }, 404)
        return new Response(object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': 'inline',
            'Cache-Control': 'public, max-age=2592000, immutable',
          },
        })
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request)
      }
      return json({ error: 'Not found' }, 404)
    } catch (err) {
      return withCors(json({ error: err?.message || 'Internal server error' }, 500), request)
    }
  },
}
