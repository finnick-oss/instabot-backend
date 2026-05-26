import express from 'express'
import cors from 'cors'
import axios from 'axios'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

const SUPABASE_READY = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
const supabase = SUPABASE_READY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null
const CONFIG_ROW_ID = 1

if (!SUPABASE_READY) console.warn('[SUPABASE] env vars missing — config will not persist!')

const IG_BASE = 'https://graph.facebook.com/v18.0'
const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID
const FB_PAGE_ID = process.env.FACEBOOK_PAGE_ID || IG_ACCOUNT_ID
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'instabot_verify_2026'

const app = express()
app.use(cors())

// serverless-http (Netlify) delivers req.body as a raw Buffer before express.json() runs,
// so express.json() skips parsing and the Buffer stays. We handle all cases explicitly.
app.use(express.raw({ type: '*/*', limit: '2mb' }))
app.use((req, res, next) => {
  if (req.body && Buffer.isBuffer(req.body)) {
    const str = req.body.toString('utf8').trim()
    try { req.body = str ? JSON.parse(str) : {} } catch { req.body = {} }
  } else if (typeof req.body === 'string') {
    const str = req.body.trim()
    try { req.body = str ? JSON.parse(str) : {} } catch { req.body = {} }
  }
  next()
})

async function loadConfig() {
  if (!SUPABASE_READY) return {}
  try {
    const { data, error } = await supabase
      .from('config')
      .select('data')
      .eq('id', CONFIG_ROW_ID)
      .single()
    if (error || !data) return {}
    return data.data || {}
  } catch { return {} }
}

async function saveConfig(payload) {
  if (!SUPABASE_READY) {
    console.warn('[SUPABASE] Cannot save — env vars not set')
    return false
  }
  try {
    const { error } = await supabase
      .from('config')
      .upsert({ id: CONFIG_ROW_ID, data: payload, updated_at: new Date().toISOString() })
    if (error) {
      console.error('[SUPABASE] saveConfig error:', error.message, error.details)
      return false
    }
    return true
  } catch (e) {
    console.error('[SUPABASE] saveConfig error:', e.message)
    return false
  }
}

async function logInteraction(entry) {
  const cfg = await loadConfig()
  if (!cfg.interaction_log) cfg.interaction_log = []
  cfg.interaction_log.unshift({ ...entry, logged_at: new Date().toISOString() })
  if (cfg.interaction_log.length > 500) cfg.interaction_log = cfg.interaction_log.slice(0, 500)
  await saveConfig(cfg)
}

// Replace {name} placeholder
function fillTemplate(text, name) {
  return (text || '').replace(/\{name\}/gi, name || 'there')
}

// Check if post is monitored based on automation config
function isPostMonitored(postId, automation) {
  if (!automation?.active) return false
  const target = automation.post_target || 'any'
  if (target === 'any') return true
  if (target === 'specific') {
    return (automation.selected_posts || []).includes(postId)
  }
  return false
}

// Check if comment matches keyword filter
function matchesKeywordFilter(commentText, automation) {
  const keywords = automation.keywords || []
  if (keywords.length === 0) return true
  const mode = automation.keyword_mode || 'any'
  const lower = commentText.toLowerCase()
  if (mode === 'any') return keywords.some(k => lower.includes(k.toLowerCase()))
  if (mode === 'all') return keywords.every(k => lower.includes(k.toLowerCase()))
  return true
}

// Pick a random reply from the list
function pickReply(replies) {
  if (!replies || replies.length === 0) return null
  return replies[Math.floor(Math.random() * replies.length)]
}

// Post a public comment reply
async function replyToComment(commentId, message) {
  const res = await axios.post(`${IG_BASE}/${commentId}/replies`, null, {
    params: { message, access_token: TOKEN }
  })
  return res.data
}

// Send a plain DM text message
async function sendDM(recipientId, text) {
  const res = await axios.post(`${IG_BASE}/${FB_PAGE_ID}/messages`, {
    recipient: { id: recipientId },
    message: { text }
  }, { params: { access_token: TOKEN } })
  return res.data
}

// Send DM via private_reply (comment-to-DM — works without prior conversation)
async function sendPrivateReply(commentId, text) {
  const res = await axios.post(`${IG_BASE}/${commentId}/private_replies`, null, {
    params: { message: text, access_token: TOKEN }
  })
  return res.data
}

// Send DM with a URL button
async function sendDMWithButton(recipientId, text, buttonLabel, url) {
  const res = await axios.post(`${IG_BASE}/${FB_PAGE_ID}/messages`, {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text,
          buttons: [{
            type: 'web_url',
            url,
            title: buttonLabel || 'Open Link'
          }]
        }
      }
    }
  }, { params: { access_token: TOKEN } })
  return res.data
}

// Send DM with quick reply buttons (for follow gate)
async function sendDMWithQuickReplies(recipientId, text, quickReplies) {
  const res = await axios.post(`${IG_BASE}/${FB_PAGE_ID}/messages`, {
    recipient: { id: recipientId },
    message: {
      text,
      quick_replies: quickReplies
    }
  }, { params: { access_token: TOKEN } })
  return res.data
}

// Check if user follows the account
async function checkFollowStatus(userId) {
  try {
    const res = await axios.get(`${IG_BASE}/${IG_ACCOUNT_ID}/followers`, {
      params: {
        user_id: userId,
        access_token: TOKEN
      }
    })
    return (res.data?.data || []).some(u => u.id === userId)
  } catch {
    return false
  }
}

// Get username from IG user ID
async function getUserName(userId) {
  try {
    const res = await axios.get(`${IG_BASE}/${userId}`, {
      params: { fields: 'name,username', access_token: TOKEN }
    })
    return res.data?.name || res.data?.username || 'there'
  } catch { return 'there' }
}

// Core automation: handle a new comment
async function handleComment(commentId, postId, commentText, commenterId, commenterName) {
  const cfg = await loadConfig()
  const automation = cfg.automation

  console.log(`[WEBHOOK] Comment on post ${postId} from ${commenterName} (${commenterId}): "${commentText}"`)

  // Skip own account comments (bot replies trigger webhooks too — infinite loop prevention)
  if (commenterId === IG_ACCOUNT_ID) {
    console.log(`[SKIP] Own account comment — ignoring`)
    return
  }

  // Deduplicate — skip if already processed this comment
  const alreadyProcessed = (cfg.interaction_log || []).some(l => l.comment_id === commentId)
  if (alreadyProcessed) {
    console.log(`[SKIP] Comment ${commentId} already processed`)
    return
  }

  if (!isPostMonitored(postId, automation)) {
    console.log(`[SKIP] Post ${postId} not monitored`)
    return
  }
  if (!matchesKeywordFilter(commentText, automation)) {
    console.log(`[SKIP] Comment doesn't match keyword filter`)
    return
  }

  const name = commenterName || await getUserName(commenterId)
  const log = { comment_id: commentId, post_id: postId, commenter_id: commenterId, name }

  // 1. Public comment reply
  if (automation.comment_replies_enabled !== false) {
    const replies = automation.comment_replies || ['Hey {name}! Check your DMs 👀']
    const reply = fillTemplate(pickReply(replies), name)
    try {
      await replyToComment(commentId, reply)
      log.comment_replied = reply
      console.log(`[REPLY] Posted comment reply: "${reply}"`)
    } catch (e) {
      console.error('[REPLY ERROR]', e.response?.data || e.message)
    }
  }

  // 2. Opening DM via private_reply (comment-to-DM — works without prior conversation)
  if (automation.dm_sequence?.opening_enabled !== false) {
    const msg = fillTemplate(automation.dm_sequence?.opening_message || 'Hey {name}! Thanks for your comment 🙌', name)
    try {
      await sendPrivateReply(commentId, msg)
      log.dm_sent = true
      console.log(`[DM] Sent private reply (opening message)`)
    } catch (e) {
      console.error('[PRIVATE REPLY ERROR]', e.response?.data || e.message)
      // Fallback to regular DM
      try {
        await sendDM(commenterId, msg)
        log.dm_sent = true
        console.log(`[DM] Sent opening message via fallback`)
      } catch (e2) {
        console.error('[DM FALLBACK ERROR]', e2.response?.data || e2.message)
      }
    }
  }

  // 3. Follow gate or direct value delivery
  const valueUrl = automation.admin_value
  const valueEnabled = automation.admin_value_enabled !== false && valueUrl

  if (automation.dm_sequence?.follow_gate_enabled && !valueEnabled) {
    // No value URL set — skip follow gate, automation is partially configured
    console.log(`[SKIP] admin_value is empty — skipping follow gate and value delivery`)
  } else if (automation.dm_sequence?.follow_gate_enabled && valueEnabled) {
    // Check if user is following
    const isFollowing = await checkFollowStatus(commenterId)
    log.follow_status = isFollowing ? 'following' : 'not_following'

    if (isFollowing) {
      // Send value directly
      const linkMsg = fillTemplate(automation.dm_sequence?.link_message || "Here's your exclusive link 🎁", name)
      const btnLabel = automation.admin_value_button_label || 'Get Your Link'
      try {
        await sendDMWithButton(commenterId, linkMsg, btnLabel, valueUrl)
        log.value_sent = true
        log.value_url = valueUrl
        console.log(`[DM] Sent value link to follower`)
      } catch (e) {
        console.error('[DM LINK ERROR]', e.response?.data || e.message)
        // Fallback: send as plain text
        try { await sendDM(commenterId, `${linkMsg}\n\n${valueUrl}`) } catch {}
      }
    } else {
      // Send follow gate prompt with follow button + "I Followed" quick reply
      const followMsg = fillTemplate(
        automation.dm_sequence?.follow_gate_message || "Hey {name}! Follow us first to get your exclusive link 👇",
        name
      )
      try {
        await axios.post(`${IG_BASE}/${FB_PAGE_ID}/messages`, {
          recipient: { id: commenterId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: followMsg,
                buttons: [
                  {
                    type: 'web_url',
                    url: `https://www.instagram.com/whoanuragbhatt/`,
                    title: '👉 Follow Now'
                  }
                ]
              }
            }
          }
        }, { params: { access_token: TOKEN } })
        log.follow_gate_sent = true
        console.log(`[DM] Sent follow gate to non-follower`)
      } catch (e) {
        console.error('[FOLLOW GATE ERROR]', e.response?.data || e.message)
        try { await sendDM(commenterId, followMsg) } catch {}
      }
    }
  } else if (valueEnabled && !automation.dm_sequence?.follow_gate_enabled) {
    // No follow gate — send value directly
    const linkMsg = fillTemplate(automation.dm_sequence?.link_message || "Here's your exclusive link 🎁", name)
    const btnLabel = automation.admin_value_button_label || 'Get Your Link'
    try {
      await sendDMWithButton(commenterId, linkMsg, btnLabel, valueUrl)
      log.value_sent = true
      console.log(`[DM] Sent value link (no follow gate)`)
    } catch (e) {
      console.error('[DM LINK ERROR]', e.response?.data || e.message)
      try { await sendDM(commenterId, `${linkMsg}\n\n${valueUrl}`) } catch {}
    }
  }

  logInteraction(log)
}

// Handle postback (user clicked "I Followed" or similar)
async function handlePostback(senderId, payload) {
  if (payload !== 'USER_FOLLOWED') return
  const cfg = await loadConfig()
  const automation = cfg.automation
  if (!automation?.active) return

  const name = await getUserName(senderId)
  const isFollowing = await checkFollowStatus(senderId)

  if (isFollowing) {
    const valueUrl = automation.admin_value
    const linkMsg = fillTemplate(automation.dm_sequence?.link_message || "Here's your exclusive link 🎁", name)
    const btnLabel = automation.admin_value_button_label || 'Get Your Link'
    try {
      await sendDMWithButton(senderId, linkMsg, btnLabel, valueUrl)
      logInteraction({ commenter_id: senderId, name, value_sent: true, follow_status: 'following', source: 'postback' })
      console.log(`[POSTBACK] Delivered value after follow confirmation`)
    } catch (e) {
      try { await sendDM(senderId, `${linkMsg}\n\n${valueUrl}`) } catch {}
    }
  } else {
    try {
      await sendDM(senderId, "Hmm, we couldn't verify your follow yet. Please follow and try again! 👀")
    } catch {}
  }
}

// ─── WEBHOOK ENDPOINTS ────────────────────────────────────────────────────────

// GET /webhook — Meta verification challenge
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  console.log(`[WEBHOOK VERIFY] mode=${mode} token=${token}`)
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified by Meta ✅')
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

// POST /webhook — incoming events from Meta
app.post('/webhook', async (req, res) => {
  res.sendStatus(200) // always respond 200 immediately

  const body = req.body
  if (body.object !== 'instagram') return

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'comments') {
        const v = change.value
        const commentId = v.id
        const postId = v.media?.id
        const commentText = v.text || ''
        const commenterId = v.from?.id
        const commenterName = v.from?.name || v.from?.username

        handleComment(commentId, postId, commentText, commenterId, commenterName)
          .catch(e => console.error('[HANDLE COMMENT ERROR]', e.message))
      }
    }

    // Handle messaging (DM postbacks + quick replies)
    for (const msg of entry.messaging || []) {
      const senderId = msg.sender?.id
      if (msg.postback) {
        handlePostback(senderId, msg.postback.payload)
          .catch(e => console.error('[POSTBACK ERROR]', e.message))
      }
      if (msg.message?.quick_reply) {
        handlePostback(senderId, msg.message.quick_reply.payload)
          .catch(e => console.error('[QUICK REPLY ERROR]', e.message))
      }
    }
  }
})

// ─── ROOT ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name: 'InstaBot API',
    version: '1.0.0',
    endpoints: ['/api/health', '/api/posts', '/api/stats', '/api/config', '/api/sync', '/webhook']
  })
})

// ─── ADMIN API ENDPOINTS ──────────────────────────────────────────────────────

const MOCK_POSTS = [
  { id: 'mock_1', media_type: 'IMAGE', caption: 'Building in public — here\'s what week 1 looked like 🧵', thumbnail_url: null, permalink: 'https://instagram.com', timestamp: new Date().toISOString() },
  { id: 'mock_2', media_type: 'VIDEO', caption: 'Behind the scenes: how I set up my automation stack', thumbnail_url: null, permalink: 'https://instagram.com', timestamp: new Date().toISOString() },
]

app.get('/api/posts', async (req, res) => {
  try {
    const { data } = await axios.get(`${IG_BASE}/${IG_ACCOUNT_ID}/media`, {
      params: { fields: 'id,caption,media_type,thumbnail_url,media_url,permalink,timestamp', limit: 50, access_token: TOKEN },
      timeout: 10000
    })
    const posts = (data.data || []).map(p => ({
      id: p.id, media_type: p.media_type, caption: p.caption || '',
      thumbnail_url: p.thumbnail_url || p.media_url || null, permalink: p.permalink, timestamp: p.timestamp
    }))
    res.json({ posts, source: 'instagram' })
  } catch (err) {
    const igErr = err.response?.data?.error
    console.warn('Instagram API error:', igErr?.message || err.message)
    res.json({ posts: MOCK_POSTS, source: 'mock', token_error: igErr?.message || err.message })
  }
})

app.get('/api/stats', async (req, res) => {
  const cfg = await loadConfig()
  const log = cfg.interaction_log || []
  res.json({
    comments_replied: log.filter(r => r.comment_replied).length,
    dms_sent: log.filter(r => r.dm_sent).length,
    clicks: log.filter(r => r.value_sent).length,
    followers_gained: log.filter(r => r.follow_status === 'following').length,
    emails_saved: log.filter(r => r.email).length
  })
})

app.get('/api/config', async (req, res) => {
  const cfg = await loadConfig()
  res.json(cfg.automation || {})
})

app.delete('/api/config', async (req, res) => {
  const cfg = await loadConfig()
  delete cfg.automation
  await saveConfig(cfg)
  console.log('[CONFIG] Automation deleted')
  res.json({ success: true })
})

app.post('/api/config', async (req, res) => {
  // Final safety net — middleware above handles this but belt-and-suspenders
  let body = req.body
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString('utf8')) } catch { body = {} }
  } else if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { body = {} }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) body = {}

  const cfg = await loadConfig()
  cfg.automation = { ...body, updated_at: new Date().toISOString() }
  const ok = await saveConfig(cfg)
  if (!ok) {
    console.error(`[CONFIG] Supabase write FAILED for active=${body.active}, name="${body.name}"`)
    return res.status(500).json({ success: false, error: 'Database write failed' })
  }
  console.log(`[CONFIG] Saved OK: active=${cfg.automation.active}, name="${cfg.automation.name}"`)
  res.json({ success: true, saved_at: new Date().toISOString() })
})

app.post('/api/sync', async (req, res) => {
  try {
    const { data } = await axios.get(`${IG_BASE}/${IG_ACCOUNT_ID}/media`, {
      params: { fields: 'id,caption,media_type,thumbnail_url,media_url,permalink,timestamp', limit: 50, access_token: TOKEN },
      timeout: 10000
    })
    const posts = data.data || []
    const cfg = await loadConfig()
    cfg.posts_cache = posts
    cfg.posts_synced_at = new Date().toISOString()
    await saveConfig(cfg)
    res.json({ success: true, count: posts.length, source: 'instagram' })
  } catch (err) {
    const igErr = err.response?.data?.error
    res.json({ success: false, error: igErr?.message || err.message })
  }
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    token_set: !!TOKEN,
    account_id_set: !!IG_ACCOUNT_ID,
    supabase_connected: SUPABASE_READY,
    webhook_verify_token: WEBHOOK_VERIFY_TOKEN,
    issues: [
      !TOKEN && 'INSTAGRAM_ACCESS_TOKEN not set',
      !IG_ACCOUNT_ID && 'INSTAGRAM_ACCOUNT_ID not set',
      !SUPABASE_READY && 'SUPABASE_URL or SUPABASE_ANON_KEY not set — config will not persist',
    ].filter(Boolean)
  })
})

// GET /api/log — recent interactions
app.get('/api/log', async (req, res) => {
  const cfg = await loadConfig()
  res.json(cfg.interaction_log || [])
})

export { app }

if (!process.env.NETLIFY) {
  const PORT = process.env.PORT || 3001
  app.listen(PORT, () => {
    console.log(`Instagram Admin API running on http://localhost:${PORT}`)
    console.log(`Token: ${TOKEN ? TOKEN.slice(0, 20) + '...' : 'NOT SET'}`)
    console.log(`Webhook verify token: ${WEBHOOK_VERIFY_TOKEN}`)
    console.log(`Webhook URL: http://localhost:${PORT}/webhook  (expose via ngrok)`)
  })
}
