// End-to-end tests for the multi-account backend: real Express app + HTTP,
// in-memory Supabase and a mocked Graph API (no network calls).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import axios from 'axios'
import { createFakeSupabase } from './fake-supabase.mjs'

process.env.INSTABOT_TEST = '1'
process.env.SUPABASE_URL = ''
process.env.INSTAGRAM_ACCESS_TOKEN = 'OWNER_PAGE_TOKEN'
process.env.INSTAGRAM_ACCOUNT_ID = 'IG_OWNER'
process.env.FACEBOOK_PAGE_ID = 'PAGE_OWNER'
process.env.META_APP_ID = 'APP_1'
process.env.META_APP_SECRET = 'test_app_secret'
process.env.PUBLIC_URL = 'https://api.example.test'
process.env.FRONTEND_URL = 'https://app.example.test'

const { app, __setSupabaseForTests } = await import('../server.js')

const GRAPH = 'https://graph.facebook.com/v25.0'

// ─── Graph API mock ───────────────────────────────────────────────────────────
let calls = []
let routes = {}
function route(method, path, handler) { routes[`${method} ${path}`] = handler }

axios.defaults.adapter = async (config) => {
  const url = config.url.startsWith(GRAPH) ? config.url.slice(GRAPH.length) : config.url
  const method = config.method.toUpperCase()
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
  const call = { method, path: url, params: config.params || {}, body }
  calls.push(call)
  const handler = routes[`${method} ${url}`]
  if (!handler) {
    const err = new Error(`Unmocked ${method} ${url}`)
    err.response = { status: 404, data: { error: { message: `Unmocked ${method} ${url}` } } }
    throw err
  }
  const out = await handler(call)
  if (out?.__error) {
    const err = new Error(out.__error)
    err.response = { status: 400, data: { error: { message: out.__error } } }
    throw err
  }
  return { data: out, status: 200, statusText: 'OK', headers: {}, config }
}
const fail = (message) => ({ __error: message })
const callsTo = (method, path) => calls.filter(c => c.method === method && c.path === path)

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
let server, base, fake
before(async () => {
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

async function http(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text, location: res.headers.get('location') }
}

const commentEvent = (igId, { commentId = 'C1', mediaId = 'MEDIA_1', from = 'USER_X', username = 'fan', text = 'PDF please' } = {}) => ({
  object: 'instagram',
  entry: [{ id: igId, time: 0, changes: [{ field: 'comments', value: { id: commentId, text, media: { id: mediaId }, from: { id: from, username } } }] }],
})
const messagingEvent = (igId, messaging) => ({ object: 'instagram', entry: [{ id: igId, time: 0, messaging: [messaging] }] })

// Connect a creator through the full OAuth flow and return their session token
async function connectViaOAuth({ igId = 'IG_B', username = 'creator_b', pageId = 'PAGE_B', pageToken = 'PAGE_B_TOKEN', fbUser = 'FB_USER_B' } = {}) {
  route('GET', '/oauth/access_token', ({ params }) => params.grant_type === 'fb_exchange_token'
    ? { access_token: 'LONG_USER_TOKEN' }
    : (params.code === 'GOOD_CODE' && params.client_secret === 'test_app_secret' && params.redirect_uri === 'https://api.example.test/api/auth/callback')
      ? { access_token: 'SHORT_USER_TOKEN' } : fail('bad code exchange'))
  route('GET', '/me', ({ params }) => params.access_token === 'LONG_USER_TOKEN' ? { id: fbUser } : fail('bad token'))
  route('GET', '/me/accounts', () => ({ data: [
    { id: 'PAGE_NO_IG', name: 'Unlinked page', access_token: 'X' },
    { id: pageId, name: 'B Page', access_token: pageToken, instagram_business_account: { id: igId, username, name: 'Creator B', profile_picture_url: 'https://img/b.jpg' } },
  ] }))
  route('POST', `/${pageId}/subscribed_apps`, () => ({ success: true }))

  const login = await http('GET', `/api/auth/login?return_to=${encodeURIComponent('https://app.example.test/')}`)
  assert.equal(login.status, 302)
  const dialog = new URL(login.location)
  assert.equal(dialog.origin + dialog.pathname, 'https://www.facebook.com/v25.0/dialog/oauth')
  assert.equal(dialog.searchParams.get('client_id'), 'APP_1')
  assert.equal(dialog.searchParams.get('redirect_uri'), 'https://api.example.test/api/auth/callback')
  assert.ok(dialog.searchParams.get('config_id'))
  const state = dialog.searchParams.get('state')

  const cb = await http('GET', `/api/auth/callback?code=GOOD_CODE&state=${state}`)
  assert.equal(cb.status, 302)
  const m = cb.location.match(/^https:\/\/app\.example\.test\/#session=(.+)$/)
  assert.ok(m, `unexpected callback redirect: ${cb.location}`)
  return m[1]
}

// Owner session (env-configured account) — sessions are normally issued by OAuth
async function ownerSession() {
  await http('POST', '/webhook', { body: { object: 'instagram', entry: [] } }) // triggers owner seeding
  const token = 'owner_session_token'
  fake.rows('sessions').push({ token_hash: crypto.createHash('sha256').update(token).digest('hex'), ig_account_id: 'IG_OWNER', expires_at: '2999-01-01T00:00:00Z' })
  return token
}

const valueAutomation = (overrides = {}) => ({
  name: 'PDF giveaway', active: true, post_target: 'specific', selected_posts: ['MEDIA_1'],
  keywords: ['PDF'], keyword_mode: 'any',
  comment_replies_enabled: true, comment_replies: ['Hey {name}! Check your DMs 👀'],
  dm_sequence: { opening_enabled: true, opening_message: 'Hi {name}!', follow_gate_enabled: false, link_message: 'Here you go 🎁' },
  admin_value_enabled: true, admin_value: 'https://example.com/guide.pdf', admin_value_button_label: 'Get the PDF',
  ...overrides,
})

beforeEach(() => {
  calls = []
  routes = {}
  fake = createFakeSupabase({
    config: [{ id: 1, data: { automation: { id: 'legacy-7', name: 'Old automation', active: true, post_target: 'any' } } }],
  })
  __setSupabaseForTests(fake)
  route('GET', '/IG_OWNER', () => ({ username: 'owner', name: 'Owner', profile_picture_url: null }))
  route('POST', '/C1/replies', () => ({ id: 'REPLY_1' }))
  route('POST', '/PAGE_B/messages', () => ({ message_id: 'M1' }))
})

// ─── Tests ────────────────────────────────────────────────────────────────────

test('health is public and does not leak the webhook verify token', async () => {
  const r = await http('GET', '/api/health')
  assert.equal(r.status, 200)
  assert.equal(r.json.oauth_configured, true)
  assert.ok(!r.text.includes('instabot_verify'))
})

test('account endpoints require a valid session', async () => {
  for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/automations'], ['GET', '/api/posts'], ['GET', '/api/log'], ['GET', '/api/stats'], ['PUT', '/api/automations/x']]) {
    assert.equal((await http(m, p)).status, 401, `${m} ${p}`)
    assert.equal((await http(m, p, { token: 'garbage' })).status, 401, `${m} ${p} with bad token`)
  }
})

test('webhook verification challenge', async () => {
  assert.equal((await http('GET', '/webhook?hub.mode=subscribe&hub.verify_token=instabot_verify_2026&hub.challenge=abc')).text, 'abc')
  assert.equal((await http('GET', '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc')).status, 403)
})

test('login rejects return_to URLs that are not allowed frontends', async () => {
  const r = await http('GET', `/api/auth/login?return_to=${encodeURIComponent('https://evil.example/')}`)
  assert.equal(r.status, 400)
})

test('OAuth callback rejects unknown or replayed state', async () => {
  assert.equal((await http('GET', '/api/auth/callback?code=GOOD_CODE&state=forged')).status, 400)
  await connectViaOAuth()
  const used = fake.rows('oauth_states')
  assert.equal(used.length, 0, 'state is single-use')
})

test('OAuth connects a creator, stores their page token and subscribes their Page', async () => {
  const token = await connectViaOAuth()
  const me = await http('GET', '/api/me', { token })
  assert.equal(me.status, 200)
  assert.equal(me.json.username, 'creator_b')
  assert.equal(me.json.page_id, 'PAGE_B')
  assert.equal(me.json.page_token, undefined, 'page token is never sent to the browser')

  const acct = fake.rows('accounts').find(a => a.ig_account_id === 'IG_B')
  assert.equal(acct.page_token, 'PAGE_B_TOKEN')
  assert.equal(acct.fb_user_id, 'FB_USER_B')
  assert.equal(fake.rows('accounts').some(a => a.page_id === 'PAGE_NO_IG'), false)
  assert.equal(callsTo('POST', '/PAGE_B/subscribed_apps')[0].params.access_token, 'PAGE_B_TOKEN')
  assert.ok(!fake.rows('sessions').some(s => s.token_hash === token), 'only the hash is stored')
})

test('OAuth with no Instagram-linked page returns an error to the frontend', async () => {
  route('GET', '/oauth/access_token', () => ({ access_token: 'T' }))
  route('GET', '/me', () => ({ id: 'FB_U' }))
  route('GET', '/me/accounts', () => ({ data: [{ id: 'P', name: 'x', access_token: 'y' }] }))
  const login = await http('GET', `/api/auth/login?return_to=${encodeURIComponent('http://localhost:5173/')}`)
  const state = new URL(login.location).searchParams.get('state')
  const cb = await http('GET', `/api/auth/callback?code=c&state=${state}`)
  assert.match(cb.location, /^http:\/\/localhost:5173\/#auth_error=/)
})

async function callbackWith(setup) {
  route('GET', '/oauth/access_token', () => ({ access_token: 'T' }))
  route('GET', '/me', () => ({ id: 'FB_U' }))
  setup()
  const login = await http('GET', `/api/auth/login?return_to=${encodeURIComponent('http://localhost:5173/')}`)
  const state = new URL(login.location).searchParams.get('state')
  return http('GET', `/api/auth/callback?code=c&state=${state}`)
}

test('OAuth error names the permissions Facebook did not grant', async () => {
  const cb = await callbackWith(() => {
    route('GET', '/me/accounts', () => ({ data: [] }))
    route('GET', '/me/businesses', () => ({ data: [] }))
    route('GET', '/me/permissions', () => ({ data: [
      { permission: 'pages_show_list', status: 'granted' },
      { permission: 'instagram_basic', status: 'declined' },
    ] }))
  })
  const msg = decodeURIComponent(cb.location.split('#auth_error=')[1])
  assert.match(msg, /instagram_basic/)
  assert.doesNotMatch(msg, /pages_show_list/)
})

test('OAuth finds Instagram accounts on Business-portfolio Pages', async () => {
  const cb = await callbackWith(() => {
    route('GET', '/me/accounts', () => ({ data: [] }))
    route('GET', '/me/businesses', () => ({ data: [{ id: 'BIZ', owned_pages: { data: [
      { id: 'PAGE_BIZ', name: 'Biz Page', access_token: 'BIZ_TOKEN', instagram_business_account: { id: 'IG_BIZ', username: 'biz_creator' } },
    ] } }] }))
    route('POST', '/PAGE_BIZ/subscribed_apps', () => ({ success: true }))
  })
  assert.match(cb.location, /#session=/)
  const acct = fake.rows('accounts').find(a => a.ig_account_id === 'IG_BIZ')
  assert.equal(acct.page_token, 'BIZ_TOKEN')
})

test('each account only sees and edits its own automations', async () => {
  const b = await connectViaOAuth()
  const owner = await ownerSession()

  assert.equal((await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation() })).status, 200)
  const bList = (await http('GET', '/api/automations', { token: b })).json
  assert.equal(bList.length, 1)
  assert.equal(bList[0].name, 'PDF giveaway')
  assert.equal(bList[0].active, true)

  // Owner sees only the migrated legacy automation
  const ownerList = (await http('GET', '/api/automations', { token: owner })).json
  assert.deepEqual(ownerList.map(a => a.id), ['legacy-7'])

  // Owner can't overwrite or delete B's automation
  assert.equal((await http('PUT', '/api/automations/a1', { token: owner, body: { name: 'hijack' } })).status, 404)
  await http('DELETE', '/api/automations/a1', { token: owner })
  assert.equal((await http('GET', '/api/automations', { token: b })).json[0].name, 'PDF giveaway')

  // B can delete it
  await http('DELETE', '/api/automations/a1', { token: b })
  assert.equal((await http('GET', '/api/automations', { token: b })).json.length, 0)
})

test('legacy automation migrates once and is not recreated after deletion', async () => {
  const owner = await ownerSession()
  await http('DELETE', '/api/automations/legacy-7', { token: owner })
  __setSupabaseForTests(fake) // simulate a new cold start on the same database
  await http('POST', '/webhook', { body: { object: 'instagram', entry: [] } })
  assert.equal((await http('GET', '/api/automations', { token: owner })).json.length, 0)
})

test('comment → public reply + opening DM with a "Send me the link" button; the tap sends the link', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation() })

  const r = await http('POST', '/webhook', { body: commentEvent('IG_B') })
  assert.equal(r.status, 200)

  const reply = callsTo('POST', '/C1/replies')
  assert.equal(reply.length, 1)
  assert.equal(reply[0].params.message, 'Hey fan! Check your DMs 👀')
  assert.equal(reply[0].params.access_token, 'PAGE_B_TOKEN')

  const dm = callsTo('POST', '/PAGE_B/messages')
  assert.equal(dm.length, 1)
  assert.deepEqual(dm[0].body.recipient, { comment_id: 'C1' })
  const opening = dm[0].body.message.attachment.payload
  assert.equal(opening.text, 'Hi fan!')
  assert.deepEqual(opening.buttons, [{ type: 'postback', title: 'Send me the link 👉', payload: 'SEND_LINK' }])
  assert.equal(dm[0].params.access_token, 'PAGE_B_TOKEN')
  assert.equal(fake.rows('interactions')[0].data.awaiting_start, true)

  // Tapping the button opens the messaging window → the link arrives as its own message
  await http('POST', '/webhook', { body: messagingEvent('IG_B', { sender: { id: 'USER_X' }, recipient: { id: 'IG_B' }, postback: { payload: 'SEND_LINK' } }) })
  const link = callsTo('POST', '/PAGE_B/messages')[1]
  assert.deepEqual(link.body.recipient, { id: 'USER_X' })
  assert.equal(link.body.message.attachment.payload.text, 'Here you go 🎁')
  assert.deepEqual(link.body.message.attachment.payload.buttons, [{ type: 'web_url', url: 'https://example.com/guide.pdf', title: 'Get the PDF' }])

  const log = (await http('GET', '/api/log', { token: b })).json
  assert.equal(log.length, 1)
  assert.equal(log[0].comment_id, 'C1')
  assert.equal(log[0].dm_sent, true)
  assert.equal(log[0].value_sent, true)
  assert.equal(log[0].awaiting_start, false)
  const stats = (await http('GET', '/api/stats', { token: b })).json
  assert.equal(stats.comments_replied, 1)
  assert.equal(stats.dms_sent, 1)
})

test('webhook retries for the same comment are ignored', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation() })
  await http('POST', '/webhook', { body: commentEvent('IG_B') })
  await http('POST', '/webhook', { body: commentEvent('IG_B') })
  assert.equal(callsTo('POST', '/C1/replies').length, 1)
  assert.equal(callsTo('POST', '/PAGE_B/messages').length, 1)
})

test('comments that should not trigger: wrong keyword, other post, own account, unknown account, inactive', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation() })
  await http('POST', '/webhook', { body: commentEvent('IG_B', { text: 'nice video' }) })
  await http('POST', '/webhook', { body: commentEvent('IG_B', { commentId: 'C2', mediaId: 'OTHER' }) })
  await http('POST', '/webhook', { body: commentEvent('IG_B', { commentId: 'C3', from: 'IG_B' }) })
  await http('POST', '/webhook', { body: commentEvent('IG_UNKNOWN', { commentId: 'C4' }) })
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation({ active: false }) })
  await http('POST', '/webhook', { body: commentEvent('IG_B', { commentId: 'C5' }) })
  assert.equal(calls.filter(c => c.method === 'POST' && /replies|messages/.test(c.path)).length, 0)
  assert.equal(fake.rows('interactions').length, 0)
})

test('comments on the owner account still work with the env token', async () => {
  const owner = await ownerSession()
  route('POST', '/C9/replies', () => ({ id: 'R' }))
  route('POST', '/PAGE_OWNER/messages', () => ({ message_id: 'M' }))
  await http('PUT', '/api/automations/legacy-7', { token: owner, body: valueAutomation({ post_target: 'any', keywords: [] }) })
  await http('POST', '/webhook', { body: commentEvent('IG_OWNER', { commentId: 'C9' }) })
  assert.equal(callsTo('POST', '/C9/replies')[0].params.access_token, 'OWNER_PAGE_TOKEN')
  assert.deepEqual(callsTo('POST', '/PAGE_OWNER/messages')[0].body.recipient, { comment_id: 'C9' })
})

test('falls back to one plain-text DM with the link when the button template is rejected', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation() })
  route('POST', '/PAGE_B/messages', ({ body }) => body.message.attachment ? fail('template not allowed') : { message_id: 'M2' })
  await http('POST', '/webhook', { body: commentEvent('IG_B') })
  const dms = callsTo('POST', '/PAGE_B/messages')
  assert.equal(dms.length, 2)
  assert.equal(dms[1].body.message.text, 'Hi fan!\n\nHere you go 🎁\n\nhttps://example.com/guide.pdf')
  const data = fake.rows('interactions')[0].data
  assert.equal(data.dm_format, 'text')
  assert.equal(data.value_sent, true)
  assert.equal(data.awaiting_start, undefined)
})

test('a failed DM is recorded with the Graph error', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation({ admin_value_enabled: false }) })
  route('POST', '/PAGE_B/messages', () => fail('(#10) Insufficient permission'))
  await http('POST', '/webhook', { body: commentEvent('IG_B') })
  const data = fake.rows('interactions')[0].data
  assert.equal(data.dm_sent, false)
  assert.match(data.dm_error, /Insufficient permission/)
  assert.ok(data.comment_replied)
})

test('follow gate: opening DM, then follow buttons, then the link only after the follow is confirmed', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation({ dm_sequence: { opening_enabled: true, opening_message: 'Hi {name}!', follow_gate_enabled: true, follow_gate_message: 'Follow first 👇', link_message: 'Unlocked 🎁' } }) })

  await http('POST', '/webhook', { body: commentEvent('IG_B') })
  const opening = callsTo('POST', '/PAGE_B/messages')[0]
  assert.deepEqual(opening.body.recipient, { comment_id: 'C1' })
  assert.equal(opening.body.message.attachment.payload.text, 'Hi fan!')
  assert.equal(opening.body.message.attachment.payload.buttons[0].payload, 'SEND_LINK')

  // A typed reply works like the button → follow gate with Follow / I followed buttons
  await http('POST', '/webhook', { body: messagingEvent('IG_B', { sender: { id: 'USER_X' }, recipient: { id: 'IG_B' }, message: { mid: 'm0', text: 'link please' } }) })
  const gate = callsTo('POST', '/PAGE_B/messages')[1]
  assert.deepEqual(gate.body.recipient, { id: 'USER_X' })
  assert.equal(gate.body.message.attachment.payload.text, 'Follow first 👇')
  assert.deepEqual(gate.body.message.attachment.payload.buttons.map(x => x.type), ['web_url', 'postback'])
  assert.equal(gate.body.message.attachment.payload.buttons[0].url, 'https://www.instagram.com/creator_b/')

  // Not following yet → nudge, no link
  route('GET', '/USER_X', () => ({ is_user_follow_business: false }))
  await http('POST', '/webhook', { body: messagingEvent('IG_B', { sender: { id: 'USER_X' }, recipient: { id: 'IG_B' }, postback: { payload: 'USER_FOLLOWED' } }) })
  let dms = callsTo('POST', '/PAGE_B/messages')
  assert.equal(dms.length, 3)
  assert.match(dms[2].body.message.attachment.payload.text, /couldn't see your follow/)
  assert.deepEqual(dms[2].body.recipient, { id: 'USER_X' })

  // Echoes of our own messages are ignored
  await http('POST', '/webhook', { body: messagingEvent('IG_B', { sender: { id: 'IG_B' }, recipient: { id: 'USER_X' }, message: { text: 'x', is_echo: true } }) })
  assert.equal(callsTo('POST', '/PAGE_B/messages').length, 3)

  // Following now (user just replies "done") → link delivered
  route('GET', '/USER_X', () => ({ is_user_follow_business: true }))
  await http('POST', '/webhook', { body: messagingEvent('IG_B', { sender: { id: 'USER_X' }, recipient: { id: 'IG_B' }, message: { mid: 'm', text: 'done' } }) })
  dms = callsTo('POST', '/PAGE_B/messages')
  assert.equal(dms.length, 4)
  assert.equal(dms[3].body.message.attachment.payload.text, 'Unlocked 🎁')
  assert.equal(dms[3].body.message.attachment.payload.buttons[0].url, 'https://example.com/guide.pdf')

  const data = fake.rows('interactions')[0].data
  assert.equal(data.follow_gate_pending, false)
  assert.equal(data.value_sent, true)
  assert.equal(data.follow_status, 'following')

  // Further messages from the user don't resend the link
  await http('POST', '/webhook', { body: messagingEvent('IG_B', { sender: { id: 'USER_X' }, recipient: { id: 'IG_B' }, message: { mid: 'm2', text: 'thanks!' } }) })
  assert.equal(callsTo('POST', '/PAGE_B/messages').length, 4)
})

test('DMs from people without a pending follow gate are left alone', async () => {
  await connectViaOAuth()
  await http('POST', '/webhook', { body: messagingEvent('IG_B', { sender: { id: 'RANDOM' }, recipient: { id: 'IG_B' }, message: { mid: 'm', text: 'hello' } }) })
  assert.equal(callsTo('POST', '/PAGE_B/messages').length, 0)
})

test('"next post" target only fires for media published after the automation was saved', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation({ post_target: 'next', selected_posts: [] }) })
  const savedAt = Date.parse(fake.rows('automations')[0].data.next_after)
  route('GET', '/OLD_MEDIA', () => ({ timestamp: new Date(savedAt - 60_000).toISOString() }))
  route('GET', '/NEW_MEDIA', () => ({ timestamp: new Date(savedAt + 60_000).toISOString() }))
  route('POST', '/C2/replies', () => ({ id: 'R' }))
  await http('POST', '/webhook', { body: commentEvent('IG_B', { commentId: 'C1', mediaId: 'OLD_MEDIA' }) })
  await http('POST', '/webhook', { body: commentEvent('IG_B', { commentId: 'C2', mediaId: 'NEW_MEDIA' }) })
  assert.equal(callsTo('POST', '/C1/replies').length, 0)
  assert.equal(callsTo('POST', '/C2/replies').length, 1)

  // Re-saving keeps the original start time
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation({ post_target: 'next', name: 'renamed' }) })
  assert.equal(Date.parse(fake.rows('automations')[0].data.next_after), savedAt)
})

test('posts are fetched with the signed-in account\'s own token', async () => {
  const b = await connectViaOAuth()
  route('GET', '/IG_B/media', ({ params }) => params.access_token === 'PAGE_B_TOKEN'
    ? { data: [{ id: 'MEDIA_1', media_type: 'VIDEO', caption: 'Comment PDF', permalink: 'https://ig/p/1', timestamp: '2026-01-01T00:00:00Z', thumbnail_url: 'https://t' }] }
    : fail('wrong token'))
  const r = await http('GET', '/api/posts', { token: b })
  assert.equal(r.status, 200)
  assert.equal(r.json.posts[0].id, 'MEDIA_1')
})

test('webhook status endpoint reports whether the Page is subscribed', async () => {
  const b = await connectViaOAuth()
  route('GET', '/PAGE_B/subscribed_apps', () => ({ data: [{ id: 'APP_1', subscribed_fields: ['feed'] }] }))
  const r = await http('GET', '/api/account/status', { token: b })
  assert.deepEqual(r.json.webhook, { subscribed: true, fields: ['feed'] })
})

test('resubscribe reports the Graph error for every field it tried', async () => {
  const b = await connectViaOAuth()
  route('POST', '/PAGE_B/subscribed_apps', ({ params }) => fail(`no permission for ${params.subscribed_fields}`))
  const r = await http('POST', '/api/account/subscribe', { token: b })
  assert.equal(r.status, 502)
  assert.equal(r.json.error, 'feed: no permission for feed | messages: no permission for messages')
})

function signedRequest(payload, secret = 'test_app_secret') {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${sig}.${body}`
}

test('Meta data-deletion callback removes the user\'s accounts, automations, sessions and logs', async () => {
  const b = await connectViaOAuth()
  await http('PUT', '/api/automations/a1', { token: b, body: valueAutomation() })
  await http('POST', '/webhook', { body: commentEvent('IG_B') })

  const forged = await http('POST', '/api/meta/data-deletion', { raw: `signed_request=${signedRequest({ user_id: 'FB_USER_B' }, 'wrong')}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(forged.status, 400)

  const r = await http('POST', '/api/meta/data-deletion', { raw: `signed_request=${signedRequest({ user_id: 'FB_USER_B' })}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(r.status, 200)
  assert.ok(r.json.confirmation_code)
  assert.match(r.json.url, /^https:\/\/api\.example\.test\/api\/meta\/deletion-status\?code=/)
  for (const t of ['accounts', 'automations', 'interactions', 'sessions']) {
    assert.equal(fake.rows(t).filter(r => r.ig_account_id === 'IG_B').length, 0, t)
  }
  assert.equal((await http('GET', '/api/me', { token: b })).status, 401)
})

test('deauthorize callback and logout', async () => {
  const b = await connectViaOAuth()
  assert.equal((await http('POST', '/api/auth/logout', { token: b })).status, 200)
  assert.equal((await http('GET', '/api/me', { token: b })).status, 401)

  const b2 = await connectViaOAuth()
  const r = await http('POST', '/api/meta/deauthorize', { raw: `signed_request=${signedRequest({ user_id: 'FB_USER_B' })}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(r.status, 200)
  assert.equal((await http('GET', '/api/me', { token: b2 })).status, 401)
})

test('disconnect deletes the account and unsubscribes the Page', async () => {
  const b = await connectViaOAuth()
  route('DELETE', '/PAGE_B/subscribed_apps', () => ({ success: true }))
  assert.equal((await http('DELETE', '/api/account', { token: b })).status, 200)
  assert.equal(callsTo('DELETE', '/PAGE_B/subscribed_apps').length, 1)
  assert.equal(fake.rows('accounts').some(a => a.ig_account_id === 'IG_B'), false)
})

test('X-Hub-Signature-256 is checked against the app secret', async () => {
  process.env.WEBHOOK_SIGNATURE_MODE = 'enforce'
  const { app: strictApp, __setSupabaseForTests: setStrict } = await import('../server.js?strict')
  delete process.env.WEBHOOK_SIGNATURE_MODE
  setStrict(fake)
  const strict = strictApp.listen(0)
  await new Promise(r => strict.once('listening', r))
  const url = `http://127.0.0.1:${strict.address().port}/webhook`
  try {
    const raw = JSON.stringify({ object: 'instagram', entry: [] })
    const good = 'sha256=' + crypto.createHmac('sha256', 'test_app_secret').update(raw).digest('hex')
    const post = (sig) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body: raw })
    assert.equal((await post(good)).status, 200)
    assert.equal((await post('sha256=' + '0'.repeat(64))).status, 401)
    assert.equal((await post(null)).status, 401)
  } finally { strict.close() }
})
