# 1Prompt — AI Setter Operating System

An open-source platform for deploying AI setters that handle inbound lead conversations on behalf of businesses — across SMS, Instagram DMs, and Facebook messages — using GoHighLevel, n8n, Supabase, and Trigger.dev.

---

## What This Is

A business connects their GoHighLevel sub-account. A lead messages them. The AI setter replies automatically — handling objections, booking appointments, following up — without the business touching anything.

This is the complete platform source code: the React dashboard, all 70+ Supabase Edge Functions, the Trigger.dev background task engine, the database schemas, and the n8n workflow templates.

---

## Architecture

Five services. All must be connected and configured for the system to work.

```
Lead sends message (SMS / Instagram / Facebook)
        ↓
GoHighLevel fires webhook
        ↓
Supabase Edge Function  (frontend/supabase/functions/)
  - Identifies the client
  - Queues the message
  - Triggers the Trigger.dev task
        ↓
Trigger.dev  (trigger/)
  - Waits out the debounce window
  - Groups messages from the same contact
  - Sends grouped message to n8n
  - Receives AI reply
  - Forwards reply to GHL
        ↓
n8n  (frontend/public/workflows/)
  - Runs the AI agent
  - Reads setter prompt and chat history
  - Returns structured reply
        ↓
GoHighLevel sends reply to lead
        ↓
Dashboard  (frontend/src/)
  - Shows live execution status
  - Manages setter configuration
  - Analytics, contacts, campaigns
```

---

## What's In This Repo

```
1prompt-os/
│
├── frontend/                        ← React dashboard + all Edge Functions
│   ├── src/
│   │   ├── pages/                   ← 50+ pages (dashboard, analytics, AI reps, contacts, etc.)
│   │   ├── components/              ← UI components (shadcn/ui + custom)
│   │   ├── hooks/                   ← Custom React hooks
│   │   ├── integrations/supabase/   ← Supabase client + generated DB types
│   │   └── lib/ utils/ types/       ← Helpers and TypeScript types
│   ├── supabase/
│   │   ├── functions/               ← 70+ Deno Edge Functions
│   │   └── migrations/              ← 300+ SQL migrations (full schema history)
│   └── public/
│       ├── workflows/               ← n8n workflow JSON exports
│       │   ├── text-engine/
│       │   ├── voice-sales-rep/
│       │   ├── ghl-booking/
│       │   ├── knowledgebase-automation/
│       │   └── database-reactivation/
│       └── retell-agents/           ← Retell voice agent JSON templates
│
├── trigger/                         ← Trigger.dev background tasks (TypeScript)
│   ├── processMessages.ts           ← core DM flow: debounce → n8n → GHL reply
│   ├── runAiJob.ts                  ← AI generation: setter config, prompt editing
│   ├── sendFollowup.ts              ← scheduled follow-up sequence
│   ├── runEngagement.ts             ← engagement automation
│   ├── executeWorkflow.ts           ← GHL workflow node execution
│   └── placeOutboundCall.ts         ← outbound call triggering
│
├── supabase/
│   ├── schema.sql                   ← platform database schema — run in YOUR Supabase project
│   └── client-schema.sql            ← client database schema — run in each CLIENT'S Supabase project
│
├── trigger.config.ts                ← Trigger.dev project config
├── package.json                     ← Trigger.dev dependencies
└── .env.example                     ← required environment variables
```

---

## What You Need

Before you start, you need accounts on all five services:

| Service | Purpose |
|---|---|
| **GoHighLevel** | CRM — sends webhooks when leads message, receives AI replies |
| **Supabase** | Platform database + Edge Functions (the webhook API layer) |
| **Trigger.dev** | Runs the background tasks in `/trigger` |
| **n8n** | Runs the AI agent (workflow JSONs in `frontend/public/workflows/`) |
| **OpenRouter** | LLM API used by n8n and Trigger.dev for AI generation |

You also need a second Supabase project per client (for their leads, chat history, and prompts).

---

## Environment Variables

**Trigger.dev** (set in Trigger.dev Dashboard → Environment Variables):

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API |

**Frontend** (create `frontend/.env.local` from `frontend/.env.example`):

| Variable | Where to find it |
|---|---|
| `VITE_SUPABASE_URL` | Supabase Dashboard → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API |

---

## High-Level Setup Steps

See [SETUP_OVERVIEW.md](./SETUP_OVERVIEW.md) for the full technical reference.

---

## This Is Not a Tutorial

This repo gives you the complete source code, all Edge Functions, database schemas, workflow templates, and background tasks. It does not walk you through how to configure each service, wire the webhooks, structure your GHL sub-account, or connect all five layers together.

If you want it fully installed and running — we deploy, debug, monitor, and report on the setters so you don't have to.

**→ [Learn about our fully managed setter service](https://us.1prompt.com/widget/bookings/1prompt-setter)**

---

## License

MIT — free to use, modify, and deploy.
