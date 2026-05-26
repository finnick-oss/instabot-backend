# InstaBot Backend

Express API deployed as Netlify serverless functions. Handles Instagram webhook events, comment automation, DM sequences, and config storage via Supabase.

## Tech Stack

- **Runtime** — Node.js (ESM)
- **Framework** — Express
- **Deployment** — Netlify Functions (serverless)
- **Storage** — Supabase (persistent config + interaction log)
- **Integrations** — Instagram Graph API, Facebook Messenger API

---

## Environment Variables

Set these in **Netlify → Site configuration → Environment variables**.

### Required

| Variable | Description | Where to get it |
|---|---|---|
| `INSTAGRAM_ACCESS_TOKEN` | Long-lived Instagram Graph API token | [Meta Developer Console](https://developers.facebook.com) → Your App → Instagram → Generate Token |
| `INSTAGRAM_ACCOUNT_ID` | Your Instagram Business Account ID | Meta Developer Console → Instagram → Account ID |
| `SUPABASE_URL` | Supabase project URL | [Supabase](https://supabase.com) → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous public key | Supabase → Project Settings → API → anon public |

### Optional

| Variable | Default | Description |
|---|---|---|
| `FACEBOOK_PAGE_ID` | Falls back to `INSTAGRAM_ACCOUNT_ID` | Facebook Page ID linked to your Instagram account |
| `WEBHOOK_VERIFY_TOKEN` | `instabot_verify_2026` | Token used to verify Meta webhook subscription |
| `PORT` | `3001` | Local dev server port (not used on Netlify) |

---

## Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run:

```sql
create table config (
  id integer primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

insert into config (id, data) values (1, '{}');
```

3. Copy **Project URL** and **anon public** key from Project Settings → API
4. Add both as Netlify env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`)

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | API info and available endpoints |
| `GET` | `/api/health` | Health check — shows token and Supabase status |
| `GET` | `/api/posts` | Fetch Instagram posts (falls back to mock if token invalid) |
| `GET` | `/api/stats` | Interaction stats (comments replied, DMs sent, clicks) |
| `GET` | `/api/config` | Get current automation config |
| `POST` | `/api/config` | Save automation config |
| `POST` | `/api/sync` | Sync posts from Instagram |
| `GET` | `/api/log` | Recent interaction log |
| `GET` | `/webhook` | Meta webhook verification |
| `POST` | `/webhook` | Incoming Instagram events (comments, DMs) |

---

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Fill in your values

# Start dev server
npm run dev
```

## Deployment

Push to `main` — Netlify auto-deploys via the `netlify.toml` config.

```bash
git push origin main
```
