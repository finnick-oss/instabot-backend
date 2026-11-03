// Local backend with an in-memory database and a mocked Graph API, for driving the frontend
// without touching Supabase or Instagram. Usage: npm run dev:mock  →  open the printed URL.
import crypto from 'node:crypto'
import axios from 'axios'
import { createFakeSupabase } from './fake-supabase.mjs'

process.env.INSTABOT_TEST = '1'
process.env.SUPABASE_URL = ''
process.env.INSTAGRAM_ACCESS_TOKEN = ''
process.env.META_APP_SECRET = 'mock_secret'
const { app, __setSupabaseForTests } = await import('../server.js')

const SESSION = 'mock-session-token'
const fake = createFakeSupabase({
  accounts: [{ ig_account_id: 'IG_DEMO', username: 'demo_creator', name: 'Demo Creator', avatar: null, page_id: 'PAGE_DEMO', page_token: 'PAGE_DEMO_TOKEN', fb_user_id: 'FB_DEMO' }],
  sessions: [{ token_hash: crypto.createHash('sha256').update(SESSION).digest('hex'), ig_account_id: 'IG_DEMO', expires_at: '2999-01-01T00:00:00Z' }],
})
__setSupabaseForTests(fake)

const POSTS = [
  { id: 'MEDIA_1', media_type: 'VIDEO', caption: 'Comment PDF and I’ll send you the full guide 👇', permalink: 'https://instagram.com/p/1', timestamp: '2026-10-01T10:00:00Z' },
  { id: 'MEDIA_2', media_type: 'IMAGE', caption: 'Behind the scenes of my automation stack', permalink: 'https://instagram.com/p/2', timestamp: '2026-09-20T10:00:00Z' },
]

export const sent = []
axios.defaults.adapter = async (config) => {
  const path = config.url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '')
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
  const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config })
  if (path === '/IG_DEMO/media') return ok({ data: POSTS })
  if (path === '/PAGE_DEMO/subscribed_apps' && config.method === 'get') return ok({ data: [] })
  if (path === '/PAGE_DEMO/subscribed_apps') return ok({ success: true })
  if (path.endsWith('/replies') || path === '/PAGE_DEMO/messages') {
    sent.push({ path, params: config.params, body })
    console.log('[MOCK GRAPH]', config.method.toUpperCase(), path, JSON.stringify(body || config.params?.message))
    return ok({ id: 'mock' })
  }
  const err = new Error(`Unmocked ${path}`)
  err.response = { status: 400, data: { error: { message: `Unmocked ${path}` } } }
  throw err
}

app.get('/__mock/sent', (req, res) => res.json(sent))
app.get('/__mock/db', (req, res) => res.json({ automations: fake.rows('automations'), interactions: fake.rows('interactions') }))

const port = process.env.PORT || 3001
app.listen(port, () => {
  console.log(`Mock InstaBot API on http://localhost:${port}`)
  console.log(`Open the frontend at http://localhost:5173/#session=${SESSION}`)
})
