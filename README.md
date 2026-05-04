# Ojarun — Backend (Phase 1)

Slim, working backend for the WhatsApp pilot. Built to grow into the full
system later without rewrites.

## What it does today

```
Customer's WhatsApp  →  Meta Cloud API  →  POST /webhooks/whatsapp
                                                    │
                                                    ▼
                                            Validate signature
                                            Skip if duplicate
                                            Save customer
                                            Save message
                                            Send auto-reply
                                                    │
                                                    ▼
                                          Meta Cloud API  →  Customer's WhatsApp
```

That's it. Five database tables, one webhook endpoint, one send wrapper.
Customers can message you, you store everything, they get an auto-reply.

## Why WhatsApp Cloud API?

It's the only way to programmatically send and receive WhatsApp messages
from a backend. The WhatsApp Business *app* on your phone is manual-only;
third-party automation tools that screen-scrape it will get your number
banned. Cloud API is Meta's official path: free to set up, pay per
conversation, supports webhooks and templates.

## Stack

NestJS · Prisma · Supabase Postgres · Meta WhatsApp Cloud API

No Redis. No queue. No bot state machine. Add those when you have
customers and the simple version starts to hurt — not before.

## Prerequisites

- Node.js ≥ 20
- Supabase project (free tier is fine)
- Meta Business account with WhatsApp Cloud API set up
- A way to expose `localhost:3000` over HTTPS for local dev (ngrok,
  Cloudflare Tunnel, etc.)

## Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill in DATABASE_URL, DIRECT_URL (from Supabase) and the WhatsApp vars.

# 3. Create the database tables in Supabase
npx prisma migrate dev --name init

# 4. Start dev server
npm run start:dev
```

Server listens on `:3000`. Webhook lives at `/webhooks/whatsapp`.

## Connecting Meta

1. Expose your dev server: `ngrok http 3000` → copy the HTTPS URL.
2. In `developers.facebook.com` → your app → WhatsApp → **Configuration**:
   - **Callback URL:** `https://<your-ngrok-url>/webhooks/whatsapp`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN` in your `.env`
3. Click **Verify and Save**. Meta hits `GET /webhooks/whatsapp` and our
   controller echoes back `hub.challenge`.
4. Subscribe to the **messages** webhook field.
5. In **App Settings → Basic**, copy the **App Secret** into
   `WHATSAPP_APP_SECRET`. Without this, signature verification can't run
   and the webhook becomes an open door.
6. Generate a **System User permanent token** (NOT the temporary 24h
   token shown on the API Setup page) → `WHATSAPP_ACCESS_TOKEN`.
7. From the API Setup page, copy the test phone number's
   **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
8. Add your own WhatsApp number as a test recipient in the API Setup
   page, then send your test number a message. You should see your
   auto-reply come back.

## Test the verify endpoint without Meta

```bash
curl "http://localhost:3000/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345"
# → prints "12345"
```

## Database

Five tables. UUIDs everywhere. snake_case in DB, camelCase in TS.

| Table         | Purpose                                                |
| ------------- | ------------------------------------------------------ |
| `customers`   | One row per WhatsApp number. Auto-created on 1st msg.  |
| `products`    | Catalogue. `current_price`, `unit`, availability.      |
| `orders`      | Has a `channel` column (whatsapp/web/app) for Phase 2. |
| `order_items` | Snapshots product name + price at order time.          |
| `messages`    | Every WhatsApp message in or out. UNIQUE on `wamid`.   |

Open `npx prisma studio` to browse the data visually.

## Project layout

```
src/
├── main.ts                       # bootstrap, raw body parser
├── app.module.ts
├── config/                       # env loading + validation
├── prisma/                       # PrismaService (global)
├── whatsapp/                     # outbound: WhatsappService.sendText()
└── webhooks/
    ├── signature.guard.ts        # validates X-Hub-Signature-256
    ├── webhooks.controller.ts    # GET verify + POST receive
    └── webhooks.module.ts
```

## Two things that aren't optional

These look like complications but they aren't — skipping them creates
real bugs:

1. **Signature validation** (`signature.guard.ts`). Without it, anyone
   on the internet can POST fake messages to your webhook.
2. **Idempotency check** (`whatsapp_message_id` UNIQUE + the
   `findUnique` check in the controller). Meta retries delivery on any
   non-2xx response, sometimes on 2xx too. Without dedup, you'd reply to
   the same message multiple times.

## What gets added when the main app arrives

The main app (full website / mobile) will extend this same backend.
You'll keep everything in this repo and add to it:

| Add                                  | When                                    |
| ------------------------------------ | --------------------------------------- |
| Bot intents (browse / order / status) | When auto-reply isn't enough             |
| Admin REST API (orders, products)     | When you need a web admin panel          |
| Admin auth (JWT or Supabase Auth)     | Same time as admin API                   |
| Addresses table + lat/long           | When delivery routing matters            |
| Payments + Paystack/Flutterwave      | When you stop accepting transfers        |
| Conversation modes (bot vs human)    | When you want soft handover              |
| BullMQ queue + Redis                 | When inline processing gets slow         |
| Order status history                 | When you need an audit log               |
| Price history                        | When admin wants "yesterday's price"     |
| Web/mobile API endpoints              | Phase 2 / Phase 3                        |

The `orders.channel` column is already there, so when the website ships
it just inserts with `channel = 'web'` and everything else stays the
same.

## Don't-skip checklist

- ✅ Signature validation
- ✅ Idempotency on `whatsapp_message_id`
- ✅ Snapshot prices on `order_items` (schema enforces it)
- ✅ Channel as a column on orders
- ✅ Persist every message (in & out)
