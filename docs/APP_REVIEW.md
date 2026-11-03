# InstaBot — Meta App Review submission

App: **n8nautochatreply** (ID `1518219729668525`), business portfolio `1636935210834210` (verified).
Goal: **Advanced access** so InstaBot can message *any* Instagram user who comments, not only people with a role on the app.

Today (Standard access) the comment reply and the first DM work for everyone, but follow-up messages from non-role users arrive as `standby` and replies fail with `(#100) not the thread owner`. Advanced access on the messaging permissions removes that limit.

---

## 1. Fix these settings first (App settings → Basic)

| Field | Current | Set to |
|---|---|---|
| Privacy policy URL | `https://eyexvisioncare.com/privacy-and-refund-policy/` (unrelated page) | `https://flow-feed.vercel.app/#privacy` |
| Site URL (Website platform) | `http://localhost:5173/` | `https://flow-feed.vercel.app/` |
| User data deletion | `https://autoreplyagent.netlify.app/api/meta/data-deletion` | keep |
| App icon | — | 1024×1024 InstaBot logo |
| Category | Utility and productivity | keep |
| Display name (optional) | n8nautochatreply | `InstaBot` — reviewers see this on the login screen |

Also in **Facebook Login for Business → Settings**, make sure the valid OAuth redirect URI includes
`https://autoreplyagent.netlify.app/api/auth/callback`.

Recommended before review: set `WEBHOOK_SIGNATURE_MODE=enforce` and a random `WEBHOOK_VERIFY_TOKEN` in Netlify (then update both webhook configs in Meta to the new token).

---

## 2. Permissions to request

Request **Advanced access** for each, in **Review → App Review → Permissions and features**. Paste the matching text into "How will your app use this permission?".

### instagram_manage_messages (the important one)
> InstaBot lets an Instagram professional account automatically answer people who comment on its posts. When someone comments a chosen keyword (for example "PDF"), InstaBot sends them a private reply to that comment with a short message and a "Send me the link" button. When the person taps the button or replies, InstaBot sends the next messages in the conversation: an optional "follow us first" step with Follow / I followed buttons, then the link the creator wants to share. We need instagram_manage_messages to send these private replies and follow-up messages, and to receive the person's replies and button taps through the messaging webhook. Messages are only sent to people who commented on the creator's post or messaged them first, and only within Meta's messaging window. The account owner can see a log of every message sent in the InstaBot dashboard.

### instagram_manage_comments
> InstaBot reads new comments on the connected creator's own posts through the comments webhook, checks them against the keywords the creator chose, and posts a short public reply (for example "Check your DMs 👀") under the matching comment. The comment ID is also required to send the private reply DM. We only access comments on media owned by the account that connected InstaBot.

### instagram_basic
> Used to read the connected Instagram professional account's ID, username, name and profile picture so the creator can see which account is connected, and to list their recent posts and reels so they can pick which posts an automation runs on. It is also used to check whether a commenter follows the account when the creator enables the optional "follow to unlock" step.

### pages_messaging
> Instagram messaging for professional accounts is sent through the Facebook Page linked to the Instagram account. InstaBot uses pages_messaging with that Page's access token to send the private replies and follow-up direct messages described for instagram_manage_messages.

### pages_manage_metadata
> Used once, when the creator connects their account, to subscribe our app to their Facebook Page (POST /{page-id}/subscribed_apps) so Meta delivers the Instagram comment and message webhooks InstaBot needs. When the creator disconnects, we use it to unsubscribe.

### pages_show_list
> Used during Facebook Login to list the Pages the person manages so InstaBot can find the Page that is linked to their Instagram professional account.

### pages_read_engagement
> Required together with pages_show_list to read the linked Instagram business account on the creator's Page and to obtain the Page access token used for the Instagram API calls above.

### business_management
> Some creators' Pages are owned by a Meta Business portfolio rather than directly by their personal profile. InstaBot uses business_management only to read the Pages in the portfolios the person manages (GET /me/businesses with owned_pages and client_pages) so it can find their Instagram-linked Page. We do not modify any business settings.

---

## 3. Instructions for the reviewer (paste into "Testing instructions")

> InstaBot is a web app at https://flow-feed.vercel.app/ .
>
> **Requirements:** a Facebook account that manages a Facebook Page linked to an Instagram professional (Business or Creator) account with at least one post, plus a second Instagram account to comment from. If you prefer, use our test account: [ADD TEST ACCOUNT CREDENTIALS HERE — do not reuse a personal password].
>
> 1. Open https://flow-feed.vercel.app/ and click **Connect Instagram**.
> 2. Log in with Facebook, select the Page linked to your Instagram professional account, and grant the requested permissions.
> 3. You are returned to the InstaBot dashboard showing the connected Instagram account. (instagram_basic, pages_show_list, pages_read_engagement, business_management)
> 4. Click **New Automation**. Choose one of your posts, enter the keyword `link`, set the link message and a URL (e.g. https://example.com), optionally enable **Follow to unlock**, then click **Save & Activate**. The dashboard confirms the webhook subscription is active. (pages_manage_metadata)
> 5. From the second Instagram account, comment `link` on that post.
> 6. Within a few seconds the post shows a public reply "Hey <name>! Check your DMs 👀" (instagram_manage_comments) and the second account receives a DM with a **Send me the link** button (instagram_manage_messages, pages_messaging).
> 7. Tap **Send me the link**. If Follow to unlock is on, a message with **Follow us** / **I followed** buttons arrives; tap **I followed**. The link message with a button arrives.
> 8. Back in the dashboard, the interaction appears in the activity log.
> 9. To remove all data, click **Disconnect** in the dashboard.
>
> Buttons render in the Instagram mobile app; Instagram on desktop web shows the same messages as text with the link and a "reply link/done" hint.

---

## 4. Screencast (one video can cover all permissions)

Record on desktop for the web app plus a phone (screen mirror) for Instagram. Keep it 2–4 minutes, English UI, no cuts in the login step.

1. Open the InstaBot URL, click **Connect Instagram**, complete Facebook Login showing every permission on the consent screen.
2. Show the dashboard with the connected account and the post list.
3. Create the automation (post, keyword, link, follow-to-unlock) and **Save & Activate**.
4. On the phone, comment the keyword from a second account.
5. Show the public reply on the post.
6. Open the DM: show the button message, tap **Send me the link**, tap **I followed**, show the link arriving.
7. Back on desktop, show the interaction in the dashboard log.
8. Click **Disconnect** to show data removal.

Caption each step with the permission it demonstrates (overlay text is enough).

---

## 5. Data handling questions (Review → Data handling)

- **Data processors / service providers:** Supabase (database), Netlify (hosting / serverless functions). No data is sold or shared for advertising.
- **Countries data is processed in:** the regions of your Supabase project and Netlify (check Supabase project settings).
- **Requests from public authorities:** answer per your situation; the app has no special process beyond complying with law.
- **Data retention / deletion:** "Disconnect" in the dashboard and Meta's data deletion callback delete the account, automations, interaction logs and tokens.

---

## 6. After approval

Advanced access applies automatically; no code change is needed. Re-test with an account that has **no** role on the app (e.g. `anuragbhatt.00`): the log should show `[DM IN] … payload SEND_LINK` (not `standby event`) followed by `[FLOW] next step sent`.
