import express from 'express'
import cors from 'cors'
import axios from 'axios'
import crypto from 'crypto'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ quiet: true })

// Prefer the service-role key (server-only); the anon key still works while RLS is off
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
const SUPABASE_READY = !!(process.env.SUPABASE_URL && SUPABASE_KEY)
let supabase = SUPABASE_READY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null

if (!SUPABASE_READY) console.warn('[SUPABASE] env vars missing — accounts and automations cannot be stored!')

const GRAPH_VERSION = 'v25.0'
const IG_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

// Owner account configured through env vars (the original single-account setup).
// It is seeded into the accounts table so it keeps working alongside OAuth-connected accounts.
const OWNER_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN
const OWNER_IG_ID = process.env.INSTAGRAM_ACCOUNT_ID
const OWNER_PAGE_ID = process.env.FACEBOOK_PAGE_ID || OWNER_IG_ID

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'instabot_verify_2026'
// 'log' (default) only warns on a bad X-Hub-Signature-256; 'enforce' rejects the request
const WEBHOOK_SIGNATURE_MODE = process.env.WEBHOOK_SIGNATURE_MODE || 'log'

const META_APP_ID = process.env.META_APP_ID || '1518219729668525'
const META_APP_SECRET = process.env.META_APP_SECRET
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET
const META_LOGIN_CONFIG_ID = process.env.META_LOGIN_CONFIG_ID || '1528229642012084'

// Netlify sets URL to the site's primary URL
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '')
const OAUTH_REDIRECT_URI = `${PUBLIC_URL}/api/auth/callback`
const FRONTEND_ORIGINS = [
  ...(process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean),
  'https://finnick-oss.github.io',
  'http://localhost:5173',
].map(u => { try { return new URL(u).origin } catch { return null } }).filter(Boolean)

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000

const app = express()
app.use(cors())

// serverless-http (Netlify) delivers req.body as a raw Buffer before body parsers run,
// so we read everything raw, keep the bytes for webhook signature checks, and parse manually.
app.use(express.raw({ type: '*/*', limit: '2mb' }))
app.use((req, res, next) => {
  let raw = req.body
  if (typeof raw === 'string') raw = Buffer.from(raw)
  req.rawBody = Buffer.isBuffer(raw) ? raw : null
  const str = req.rawBody ? req.rawBody.toString('utf8').trim() : ''
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    req.body = Object.fromEntries(new URLSearchParams(str))
  } else if (req.rawBody) {
    try { req.body = str ? JSON.parse(str) : {} } catch { req.body = {} }
  }
  if (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) req.body = {}
  next()
})

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`)
  next()
})

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const randomToken = () => crypto.randomBytes(32).toString('base64url')
const graphError = (e) => e.response?.data?.error?.message || e.message

function db() {
  if (!supabase) throw new Error('Supabase is not configured')
  return supabase
}

// Throw on Supabase errors so callers don't silently continue with missing data
function must({ data, error }) {
  if (error) throw new Error(`[DB] ${error.message}`)
  return data
}

// Replace {name} placeholder
function fillTemplate(text, name) {
  return (text || '').replace(/\{name\}/gi, name || 'there')
}

// Pick a random reply from the list
function pickReply(replies) {
  if (!replies || replies.length === 0) return null
  return replies[Math.floor(Math.random() * replies.length)]
}

// Button titles are limited to 20 characters by the Messenger/Instagram API
const buttonTitle = (s, fallback) => (s || fallback).slice(0, 20)

function publicAccount(account) {
  return {
    ig_account_id: account.ig_account_id,
    username: account.username,
    name: account.name || account.username,
    avatar: account.avatar || null,
    page_id: account.page_id,
    page_name: account.page_name || null,
    connected_at: account.connected_at,
  }
}

function automationFromRow(row) {
  return { ...row.data, id: row.id, active: row.active }
}

// ─── DATA ACCESS ──────────────────────────────────────────────────────────────

async function getAccount(igAccountId) {
  return must(await db().from('accounts').select('*').eq('ig_account_id', igAccountId).maybeSingle())
}

async function getActiveAutomations(igAccountId) {
  const rows = must(await db().from('automations').select('*').eq('ig_account_id', igAccountId).eq('active', true).order('updated_at', { ascending: false }))
  return rows.map(automationFromRow)
}

async function updateInteraction(id, data) {
  must(await db().from('interactions').update({ data }).eq('id', id))
}

// Seed the env-configured owner account once per cold start and migrate its legacy automation
let ownerSeed = null
function seedOwnerAccount() {
  if (!supabase || !OWNER_TOKEN || !OWNER_IG_ID) return Promise.resolve()
  if (!ownerSeed) {
    ownerSeed = doSeedOwnerAccount().catch(e => {
      console.error('[SEED] owner account:', e.message)
      ownerSeed = null
    })
  }
  return ownerSeed
}

async function doSeedOwnerAccount() {
  const existing = await getAccount(OWNER_IG_ID)
  if (!existing) {
    let profile = {}
    try {
      const { data } = await axios.get(`${IG_BASE}/${OWNER_IG_ID}`, {
        params: { fields: 'username,name,profile_picture_url', access_token: OWNER_TOKEN }, timeout: 8000
      })
      profile = data
    } catch (e) { console.warn('[SEED] profile lookup failed:', graphError(e)) }
    must(await db().from('accounts').insert({
      ig_account_id: OWNER_IG_ID,
      username: profile.username,
      name: profile.name || profile.username,
      avatar: profile.profile_picture_url,
      page_id: OWNER_PAGE_ID,
      page_token: OWNER_TOKEN,
    }))
    console.log(`[SEED] owner account ${OWNER_IG_ID} added`)
  }

  // The old backend stored a single automation in config row 1 — move it over once
  const legacy = await db().from('config').select('data').eq('id', 1).maybeSingle()
  const cfg = legacy.data?.data
  if (cfg?.automation?.name && !cfg.automation_migrated) {
    const a = cfg.automation
    must(await db().from('automations').upsert({
      id: String(a.id || 'legacy-1'), ig_account_id: OWNER_IG_ID, data: a, active: !!a.active,
    }))
    must(await db().from('config').update({ data: { ...cfg, automation_migrated: true } }).eq('id', 1))
    console.log('[SEED] migrated legacy automation')
  }
}

// ─── INSTAGRAM / GRAPH API ────────────────────────────────────────────────────

// Post a public comment reply
async function replyToComment(account, commentId, message) {
  const res = await axios.post(`${IG_BASE}/${commentId}/replies`, null, {
    params: { message, access_token: account.page_token }, timeout: 10000
  })
  return res.data
}

// Send a message. recipient is { comment_id } for a private reply or { id } inside the 24h window.
async function sendMessage(account, recipient, message) {
  const res = await axios.post(`${IG_BASE}/${account.page_id}/messages`, { recipient, message }, {
    params: { access_token: account.page_token }, timeout: 10000
  })
  return res.data
}

function buttonTemplate(text, buttons) {
  return { attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640), buttons } } }
}

// Send a button template; if the API rejects it, fall back to plain text
async function sendWithButtons(account, recipient, text, buttons, fallbackText) {
  try {
    await sendMessage(account, recipient, buttonTemplate(text, buttons))
    return { ok: true, format: 'buttons' }
  } catch (e) {
    console.warn('[DM] button template failed, sending text:', graphError(e))
    try {
      await sendMessage(account, recipient, { text: fallbackText })
      return { ok: true, format: 'text' }
    } catch (e2) {
      return { ok: false, error: graphError(e2) }
    }
  }
}

// Only available once the user has messaged the business (Instagram user profile API)
async function checkFollowStatus(account, igsid) {
  try {
    const { data } = await axios.get(`${IG_BASE}/${igsid}`, {
      params: { fields: 'is_user_follow_business', access_token: account.page_token }, timeout: 8000
    })
    return typeof data.is_user_follow_business === 'boolean' ? data.is_user_follow_business : null
  } catch (e) {
    console.warn('[FOLLOW CHECK]', graphError(e))
    return null
  }
}

const mediaTimestampCache = new Map()
async function getMediaTimestamp(account, mediaId) {
  if (mediaTimestampCache.has(mediaId)) return mediaTimestampCache.get(mediaId)
  try {
    const { data } = await axios.get(`${IG_BASE}/${mediaId}`, {
      params: { fields: 'timestamp', access_token: account.page_token }, timeout: 8000
    })
    const ts = data.timestamp ? new Date(data.timestamp).getTime() : null
    mediaTimestampCache.set(mediaId, ts)
    return ts
  } catch { return null }
}

// The app must be installed on the Page for Meta to deliver that Instagram account's webhooks
async function subscribePage(pageId, pageToken) {
  let lastError
  for (const fields of ['feed', 'messages']) {
    try {
      await axios.post(`${IG_BASE}/${pageId}/subscribed_apps`, null, {
        params: { subscribed_fields: fields, access_token: pageToken }, timeout: 10000
      })
      return { ok: true, fields }
    } catch (e) { lastError = graphError(e) }
  }
  return { ok: false, error: lastError }
}

async function getPageSubscription(account) {
  try {
    const { data } = await axios.get(`${IG_BASE}/${account.page_id}/subscribed_apps`, {
      params: { access_token: account.page_token }, timeout: 10000
    })
    const ours = (data.data || []).find(a => a.id === META_APP_ID)
    return { subscribed: !!ours, fields: ours?.subscribed_fields || [] }
  } catch (e) {
    return { subscribed: null, error: graphError(e) }
  }
}

// ─── AUTOMATION ENGINE ────────────────────────────────────────────────────────

// Check if post is monitored based on automation config
async function isPostMonitored(account, postId, automation) {
  if (!automation?.active) return false
  const target = automation.post_target || 'any'
  if (target === 'any') return true
  if (target === 'specific') return (automation.selected_posts || []).includes(postId)
  if (target === 'next') {
    // "Next post" = any media published after the automation was saved
    const since = automation.next_after ? new Date(automation.next_after).getTime() : null
    if (!since || !postId) return false
    const ts = await getMediaTimestamp(account, postId)
    return ts !== null && ts >= since
  }
  return false
}

// Check if comment matches keyword filter
function matchesKeywordFilter(commentText, automation) {
  const keywords = (automation.keywords || []).filter(Boolean)
  if (keywords.length === 0) return true
  const mode = automation.keyword_mode || 'any'
  const lower = (commentText || '').toLowerCase()
  if (mode === 'all') return keywords.every(k => lower.includes(k.toLowerCase()))
  return keywords.some(k => lower.includes(k.toLowerCase()))
}

function valueMessage(automation, name) {
  return fillTemplate(automation.dm_sequence?.link_message || "Here's your exclusive link 🎁", name)
}

function valueButtons(automation) {
  return [{ type: 'web_url', url: automation.admin_value, title: buttonTitle(automation.admin_value_button_label, 'Get Your Link') }]
}

function followGateButtons(account) {
  return [
    { type: 'web_url', url: `https://www.instagram.com/${account.username}/`, title: 'Follow us' },
    { type: 'postback', title: 'I followed ✅', payload: 'USER_FOLLOWED' },
  ]
}

// Core automation: handle a new comment for a connected account
async function handleComment(account, v) {
  const igId = account.ig_account_id
  const commentId = v.id
  const postId = v.media?.id
  const commentText = v.text || ''
  const commenterId = v.from?.id
  const name = v.from?.username || v.from?.name || 'there'

  console.log(`[WEBHOOK] @${account.username}: comment ${commentId} on ${postId} from ${name} (${commenterId}): "${commentText}"`)

  // Skip own account comments (bot replies trigger webhooks too — infinite loop prevention)
  if (!commentId || !commenterId || commenterId === igId) {
    console.log('[SKIP] Own account comment or missing ids')
    return
  }

  let automation = null
  for (const a of await getActiveAutomations(igId)) {
    if (await isPostMonitored(account, postId, a) && matchesKeywordFilter(commentText, a)) { automation = a; break }
  }
  if (!automation) {
    console.log('[SKIP] No active automation matches this post/comment')
    return
  }

  // Claim the comment first: the unique (account, comment) key makes webhook retries no-ops
  const claim = await db().from('interactions')
    .insert({ ig_account_id: igId, automation_id: automation.id, comment_id: commentId, commenter_id: commenterId, data: {} })
    .select('id').single()
  if (claim.error) {
    if (claim.error.code === '23505') { console.log(`[SKIP] Comment ${commentId} already processed`); return }
    throw new Error(`[DB] ${claim.error.message}`)
  }

  const log = { post_id: postId, name, comment_text: commentText, automation_name: automation.name }

  // 1. Public comment reply
  if (automation.comment_replies_enabled !== false) {
    const reply = fillTemplate(pickReply(automation.comment_replies) || 'Hey {name}! Check your DMs 👀', name)
    try {
      await replyToComment(account, commentId, reply)
      log.comment_replied = reply
      console.log(`[REPLY] "${reply}"`)
    } catch (e) {
      log.comment_reply_error = graphError(e)
      console.error('[REPLY ERROR]', log.comment_reply_error)
    }
  }

  // 2. Private reply DM. Instagram allows one private reply per comment until the user answers,
  //    so the opening message, follow gate and value link are combined into that single message.
  const seq = automation.dm_sequence || {}
  const valueEnabled = automation.admin_value_enabled !== false && !!automation.admin_value
  const followGate = !!seq.follow_gate_enabled && valueEnabled
  const opening = seq.opening_enabled !== false
    ? fillTemplate(seq.opening_message || 'Hey {name}! Thanks for your comment 🙌', name)
    : ''
  const recipient = { comment_id: commentId }

  let result = null
  if (followGate) {
    const gate = fillTemplate(seq.follow_gate_message || 'Follow us first to get your exclusive link 👇', name)
    const text = [opening, gate].filter(Boolean).join('\n\n')
    const fallback = `${text}\n\nFollow https://www.instagram.com/${account.username}/ then reply "done" here 👇`
    result = await sendWithButtons(account, recipient, text, followGateButtons(account), fallback)
    if (result.ok) { log.follow_gate_sent = true; log.follow_gate_pending = true }
  } else if (valueEnabled) {
    const text = [opening, valueMessage(automation, name)].filter(Boolean).join('\n\n')
    result = await sendWithButtons(account, recipient, text, valueButtons(automation), `${text}\n\n${automation.admin_value}`)
    if (result.ok) { log.value_sent = true; log.value_url = automation.admin_value }
  } else if (opening) {
    try {
      await sendMessage(account, recipient, { text: opening })
      result = { ok: true, format: 'text' }
    } catch (e) { result = { ok: false, error: graphError(e) } }
  }

  if (result) {
    log.dm_sent = result.ok
    if (result.ok) log.dm_format = result.format
    else { log.dm_error = result.error; console.error('[DM ERROR]', result.error) }
  }

  await updateInteraction(claim.data.id, log)
}

// Handle DM events: "I followed" postbacks / quick replies, or any text reply to a follow gate
async function handleMessage(account, msg) {
  if (msg.message?.is_echo) return
  const senderId = msg.sender?.id
  if (!senderId || senderId === account.ig_account_id) return

  const payload = msg.postback?.payload || msg.message?.quick_reply?.payload
  if (!payload && !msg.message?.text) return
  if (payload && payload !== 'USER_FOLLOWED') return

  // Only act when this user has a pending follow gate from one of our automations
  const rows = must(await db().from('interactions').select('*')
    .eq('ig_account_id', account.ig_account_id).eq('commenter_id', senderId)
    .order('created_at', { ascending: false }).limit(5))
  const pending = rows.find(r => r.data?.follow_gate_pending)
  if (!pending) return

  const automationRow = must(await db().from('automations').select('*').eq('id', pending.automation_id).maybeSingle())
  if (!automationRow) return
  const automation = automationFromRow(automationRow)
  const name = pending.data?.name

  const following = await checkFollowStatus(account, senderId)
  const recipient = { id: senderId }
  const data = { ...pending.data }

  if (following === false) {
    await sendWithButtons(account, recipient,
      "Hmm, we couldn't see your follow yet 👀 Follow us and tap the button again!",
      followGateButtons(account),
      `Hmm, we couldn't see your follow yet 👀 Follow https://www.instagram.com/${account.username}/ and reply "done" again!`)
    data.follow_status = 'not_following'
    await updateInteraction(pending.id, data)
    return
  }

  // following === null means Instagram didn't return the field; deliver rather than block the user
  const text = valueMessage(automation, name)
  const result = await sendWithButtons(account, recipient, text, valueButtons(automation), `${text}\n\n${automation.admin_value}`)
  data.follow_status = following ? 'following' : 'unverified'
  if (result.ok) {
    data.follow_gate_pending = false
    data.value_sent = true
    data.value_url = automation.admin_value
    console.log(`[FOLLOW GATE] value delivered to ${senderId}`)
  } else {
    data.value_error = result.error
  }
  await updateInteraction(pending.id, data)
}

// ─── WEBHOOK ENDPOINTS ────────────────────────────────────────────────────────

function signatureValid(req) {
  const secrets = [META_APP_SECRET, INSTAGRAM_APP_SECRET].filter(Boolean)
  if (secrets.length === 0) return true
  const sig = req.headers['x-hub-signature-256']
  if (!sig || !req.rawBody) return false
  return secrets.some(secret => {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  })
}

// GET /webhook — Meta verification challenge
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified by Meta ✅')
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

// POST /webhook — incoming events from Meta
app.post('/webhook', async (req, res) => {
  if (!signatureValid(req)) {
    console.warn('[WEBHOOK] X-Hub-Signature-256 mismatch')
    if (WEBHOOK_SIGNATURE_MODE === 'enforce') return res.sendStatus(401)
  }

  const body = req.body
  console.log(`[WEBHOOK POST] object=${body?.object} | entry count=${body?.entry?.length}`)
  if (body.object !== 'instagram') return res.sendStatus(200)

  await seedOwnerAccount()

  // Serverless functions freeze once the response is sent, so finish processing before replying
  const tasks = []
  for (const entry of body.entry || []) {
    tasks.push((async () => {
      const account = await getAccount(String(entry.id))
      if (!account) {
        console.log(`[WEBHOOK SKIP] No connected account for ${entry.id}`)
        return
      }
      for (const change of entry.changes || []) {
        if (change.field === 'comments') await handleComment(account, change.value || {})
      }
      for (const msg of entry.messaging || []) await handleMessage(account, msg)
    })().catch(e => console.error('[WEBHOOK ERROR]', e.message)))
  }

  await Promise.all(tasks)
  res.sendStatus(200)
})

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function createSession(igAccountId) {
  const token = randomToken()
  must(await db().from('sessions').insert({
    token_hash: sha256(token),
    ig_account_id: igAccountId,
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  }))
  return token
}

async function requireAuth(req, res, next) {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/)
  if (!match) return res.status(401).json({ error: 'Not signed in' })
  if (!supabase) return res.status(503).json({ error: 'Database not configured' })

  const tokenHash = sha256(match[1])
  const session = must(await db().from('sessions').select('*').eq('token_hash', tokenHash).maybeSingle())
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'Session expired — please sign in again' })
  }
  const account = await getAccount(session.ig_account_id)
  if (!account) return res.status(401).json({ error: 'Account disconnected' })

  req.account = account
  req.sessionHash = tokenHash
  next()
}

function validReturnTo(returnTo) {
  try {
    const url = new URL(returnTo)
    return FRONTEND_ORIGINS.includes(url.origin) ? url.origin + url.pathname : null
  } catch { return null }
}

// GET /api/auth/login?return_to=<frontend url> — start Facebook Login for Business
app.get('/api/auth/login', async (req, res) => {
  const returnTo = validReturnTo(req.query.return_to)
  if (!returnTo) return res.status(400).json({ error: 'return_to must be one of the allowed frontend URLs', allowed: FRONTEND_ORIGINS })
  if (!META_APP_SECRET) return res.redirect(`${returnTo}#auth_error=${encodeURIComponent('Login is not configured yet (META_APP_SECRET missing)')}`)

  const state = randomToken()
  must(await db().from('oauth_states').delete().lt('created_at', new Date(Date.now() - OAUTH_STATE_TTL_MS).toISOString()))
  must(await db().from('oauth_states').insert({ state, return_to: returnTo }))

  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    config_id: META_LOGIN_CONFIG_ID,
    response_type: 'code',
    override_default_response_type: 'true',
    state,
  })
  res.redirect(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`)
})

// GET /api/auth/callback — Meta redirects here with ?code&state
const PAGE_FIELDS = 'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}'
const LOGIN_PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages']

async function getBusinessPages(userToken) {
  try {
    const { data } = await axios.get(`${IG_BASE}/me/businesses`, {
      params: { fields: `owned_pages.limit(100){${PAGE_FIELDS}},client_pages.limit(100){${PAGE_FIELDS}}`, limit: 50, access_token: userToken },
      timeout: 15000
    })
    const seen = new Map()
    for (const b of data.data || []) {
      for (const p of [...(b.owned_pages?.data || []), ...(b.client_pages?.data || [])]) seen.set(p.id, p)
    }
    return [...seen.values()]
  } catch (e) {
    console.warn('[AUTH] /me/businesses lookup failed:', graphError(e))
    return []
  }
}

// Explain why no account was found: missing permissions, no Page chosen, or Pages without Instagram
async function describeMissingPages(userToken, pages) {
  let granted = null
  try {
    const { data } = await axios.get(`${IG_BASE}/me/permissions`, { params: { access_token: userToken }, timeout: 10000 })
    granted = (data.data || []).filter(p => p.status === 'granted').map(p => p.permission)
  } catch (e) { console.warn('[AUTH] /me/permissions failed:', graphError(e)) }
  const missing = granted ? LOGIN_PERMISSIONS.filter(p => !granted.includes(p)) : []
  if (missing.length) return `Facebook didn't grant these permissions: ${missing.join(', ')}. Add them to the app's Facebook Login for Business configuration and approve them when connecting.`
  if (pages.length === 0) return 'Facebook returned no Pages. When connecting, select the Facebook Page linked to your Instagram professional account.'
  return `No Instagram professional account is linked to the Facebook Pages you selected (${pages.map(p => p.name).join(', ')}). Link your Instagram account to one of them in Meta Business Suite, then connect again.`
}

app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error_description: deniedReason } = req.query
  const stateRow = state
    ? must(await db().from('oauth_states').select('*').eq('state', state).maybeSingle())
    : null
  if (!stateRow || Date.now() - new Date(stateRow.created_at).getTime() > OAUTH_STATE_TTL_MS) {
    return res.status(400).send('Login link expired. Please go back and try connecting again.')
  }
  must(await db().from('oauth_states').delete().eq('state', state))
  const back = (fragment) => res.redirect(`${stateRow.return_to}#${fragment}`)

  if (!code) return back(`auth_error=${encodeURIComponent(deniedReason || 'Login was cancelled')}`)

  try {
    // 1. Exchange code for a user token, then upgrade it to a long-lived one when possible
    const { data: tokenData } = await axios.get(`${IG_BASE}/oauth/access_token`, {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: OAUTH_REDIRECT_URI, code },
      timeout: 15000
    })
    let userToken = tokenData.access_token
    try {
      const { data: longLived } = await axios.get(`${IG_BASE}/oauth/access_token`, {
        params: { grant_type: 'fb_exchange_token', client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: userToken },
        timeout: 15000
      })
      userToken = longLived.access_token || userToken
    } catch (e) { console.warn('[AUTH] long-lived exchange failed:', graphError(e)) }

    const { data: me } = await axios.get(`${IG_BASE}/me`, { params: { fields: 'id', access_token: userToken }, timeout: 10000 })

    // 2. Find every Page the user granted that has an Instagram professional account linked
    const { data: pages } = await axios.get(`${IG_BASE}/me/accounts`, {
      params: { fields: PAGE_FIELDS, limit: 100, access_token: userToken },
      timeout: 15000
    })
    const isLinked = p => p.instagram_business_account && p.access_token
    let linked = (pages.data || []).filter(isLinked)
    // Pages owned by a Business portfolio don't always show up in /me/accounts
    if (linked.length === 0) linked = (await getBusinessPages(userToken)).filter(isLinked)
    if (linked.length === 0) {
      const message = await describeMissingPages(userToken, pages.data || [])
      console.warn('[AUTH] no linked Instagram account:', message)
      return back(`auth_error=${encodeURIComponent(message)}`)
    }

    // 3. Store each account (page tokens from a long-lived user token don't expire) and install the app on its Page
    for (const page of linked) {
      const ig = page.instagram_business_account
      must(await db().from('accounts').upsert({
        ig_account_id: ig.id,
        username: ig.username,
        name: ig.name || ig.username,
        avatar: ig.profile_picture_url || null,
        page_id: page.id,
        page_name: page.name,
        page_token: page.access_token,
        fb_user_id: me.id,
        updated_at: new Date().toISOString(),
      }))
      const sub = await subscribePage(page.id, page.access_token)
      console.log(`[AUTH] connected @${ig.username} (page ${page.id}) — webhook subscription ${sub.ok ? 'ok' : 'FAILED: ' + sub.error}`)
    }

    const session = await createSession(linked[0].instagram_business_account.id)
    back(`session=${session}`)
  } catch (e) {
    console.error('[AUTH] OAuth failed:', graphError(e))
    back(`auth_error=${encodeURIComponent(graphError(e))}`)
  }
})

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  must(await db().from('sessions').delete().eq('token_hash', req.sessionHash))
  res.json({ success: true })
})

app.get('/api/me', requireAuth, (req, res) => {
  res.json(publicAccount(req.account))
})

// GET /api/account/status — is Meta delivering this account's webhooks?
app.get('/api/account/status', requireAuth, async (req, res) => {
  res.json({ ...publicAccount(req.account), webhook: await getPageSubscription(req.account) })
})

// POST /api/account/subscribe — retry installing the app on the Page
app.post('/api/account/subscribe', requireAuth, async (req, res) => {
  const result = await subscribePage(req.account.page_id, req.account.page_token)
  res.status(result.ok ? 200 : 502).json(result)
})

// DELETE /api/account — disconnect and delete all of this account's data
app.delete('/api/account', requireAuth, async (req, res) => {
  try {
    await axios.delete(`${IG_BASE}/${req.account.page_id}/subscribed_apps`, { params: { access_token: req.account.page_token }, timeout: 10000 })
  } catch (e) { console.warn('[ACCOUNT] unsubscribe failed:', graphError(e)) }
  must(await db().from('accounts').delete().eq('ig_account_id', req.account.ig_account_id))
  res.json({ success: true })
})

// Meta signed_request (deauthorize + data deletion callbacks)
function parseSignedRequest(signedRequest) {
  if (!META_APP_SECRET || !signedRequest) return null
  const [sig, payload] = signedRequest.split('.')
  if (!sig || !payload) return null
  const expected = crypto.createHmac('sha256', META_APP_SECRET).update(payload).digest('base64url')
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
}

async function deleteFacebookUserData(fbUserId) {
  must(await db().from('accounts').delete().eq('fb_user_id', String(fbUserId)))
}

app.post('/api/meta/deauthorize', async (req, res) => {
  const data = parseSignedRequest(req.body.signed_request)
  if (!data?.user_id) return res.status(400).json({ error: 'Invalid signed_request' })
  await deleteFacebookUserData(data.user_id)
  console.log(`[META] deauthorized user ${data.user_id}`)
  res.json({ success: true })
})

app.post('/api/meta/data-deletion', async (req, res) => {
  const data = parseSignedRequest(req.body.signed_request)
  if (!data?.user_id) return res.status(400).json({ error: 'Invalid signed_request' })
  await deleteFacebookUserData(data.user_id)
  const code = sha256(`${data.user_id}:${Date.now()}`).slice(0, 16)
  console.log(`[META] data deletion for user ${data.user_id}, code ${code}`)
  res.json({ url: `${PUBLIC_URL}/api/meta/deletion-status?code=${code}`, confirmation_code: code })
})

app.get('/api/meta/deletion-status', (req, res) => {
  res.json({ confirmation_code: req.query.code || null, status: 'All data for this Facebook user has been deleted.' })
})

// ─── ROOT ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'InstaBot API', version: '2.0.0' })
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    supabase_connected: SUPABASE_READY,
    oauth_configured: !!META_APP_SECRET,
    owner_account_configured: !!(OWNER_TOKEN && OWNER_IG_ID),
    issues: [
      !SUPABASE_READY && 'SUPABASE_URL / SUPABASE key not set',
      !META_APP_SECRET && 'META_APP_SECRET not set — "Connect Instagram" login is disabled',
    ].filter(Boolean)
  })
})

// ─── ACCOUNT API (requires sign-in) ───────────────────────────────────────────

async function fetchPosts(account) {
  const { data } = await axios.get(`${IG_BASE}/${account.ig_account_id}/media`, {
    params: { fields: 'id,caption,media_type,thumbnail_url,media_url,permalink,timestamp', limit: 50, access_token: account.page_token },
    timeout: 10000
  })
  return (data.data || []).map(p => ({
    id: p.id, media_type: p.media_type, caption: p.caption || '',
    thumbnail_url: p.thumbnail_url || p.media_url || null, permalink: p.permalink, timestamp: p.timestamp
  }))
}

app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    res.json({ posts: await fetchPosts(req.account), source: 'instagram' })
  } catch (e) {
    res.status(502).json({ posts: [], error: graphError(e) })
  }
})

app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const posts = await fetchPosts(req.account)
    res.json({ success: true, count: posts.length, posts })
  } catch (e) {
    res.json({ success: false, error: graphError(e) })
  }
})

app.get('/api/automations', requireAuth, async (req, res) => {
  const rows = must(await db().from('automations').select('*').eq('ig_account_id', req.account.ig_account_id).order('created_at', { ascending: true }))
  res.json(rows.map(automationFromRow))
})

app.put('/api/automations/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id)
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Invalid automation' })

  const existing = must(await db().from('automations').select('ig_account_id, data').eq('id', id).maybeSingle())
  if (existing && existing.ig_account_id !== req.account.ig_account_id) return res.status(404).json({ error: 'Automation not found' })

  const data = { ...body, id }
  delete data.active
  if (data.post_target === 'next') {
    // Keep the original start time so editing doesn't skip posts published in between
    data.next_after = existing?.data?.post_target === 'next' && existing.data.next_after ? existing.data.next_after : new Date().toISOString()
  } else {
    delete data.next_after
  }
  must(await db().from('automations').upsert({
    id, ig_account_id: req.account.ig_account_id, data, active: !!body.active, updated_at: new Date().toISOString(),
  }))
  res.json({ success: true, automation: { ...data, active: !!body.active } })
})

app.delete('/api/automations/:id', requireAuth, async (req, res) => {
  must(await db().from('automations').delete().eq('id', String(req.params.id)).eq('ig_account_id', req.account.ig_account_id))
  res.json({ success: true })
})

app.get('/api/stats', requireAuth, async (req, res) => {
  const rows = must(await db().from('interactions').select('data').eq('ig_account_id', req.account.ig_account_id))
  const logs = rows.map(r => r.data || {})
  res.json({
    comments_replied: logs.filter(r => r.comment_replied).length,
    dms_sent: logs.filter(r => r.dm_sent).length,
    clicks: logs.filter(r => r.value_sent).length,
    followers_gained: logs.filter(r => r.follow_status === 'following').length,
    emails_saved: logs.filter(r => r.email).length
  })
})

// GET /api/log — recent interactions for this account
app.get('/api/log', requireAuth, async (req, res) => {
  const rows = must(await db().from('interactions').select('*').eq('ig_account_id', req.account.ig_account_id).order('created_at', { ascending: false }).limit(100))
  res.json(rows.map(r => ({
    ...r.data, comment_id: r.comment_id, commenter_id: r.commenter_id, automation_id: r.automation_id, logged_at: r.created_at
  })))
})

// Convert thrown errors (e.g. database failures) into JSON responses
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message)
  res.status(500).json({ error: err.message })
})

// Test hook: swap the Supabase client for an in-memory fake
export function __setSupabaseForTests(client) {
  supabase = client
  ownerSeed = null
  mediaTimestampCache.clear()
}

export { app, seedOwnerAccount }

if (!process.env.NETLIFY && !process.env.INSTABOT_TEST) {
  const PORT = process.env.PORT || 3001
  app.listen(PORT, () => {
    console.log(`InstaBot API running on http://localhost:${PORT}`)
    console.log(`OAuth redirect URI: ${OAUTH_REDIRECT_URI}`)
    console.log(`Allowed frontend origins: ${FRONTEND_ORIGINS.join(', ')}`)
  })
}
