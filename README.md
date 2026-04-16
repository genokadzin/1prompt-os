# 1Prompt — AI Setter Operating System

An open-source platform for deploying AI setters that handle inbound lead conversations on behalf of businesses — across SMS, Instagram DMs, and Facebook messages — using GoHighLevel, n8n, Supabase, and Trigger.dev.

---

## What This Is

A business connects their GoHighLevel sub-account. A lead messages them. The AI setter replies automatically — handling objections, booking appointments, following up — without the business touching anything.

This repo contains the background task engine (Trigger.dev) and the main platform database schema (Supabase). The frontend dashboard and Edge Functions are built separately on Lovable + Supabase.

---

## Architecture

Five services. All must be connected and configured for the system to work.

```
Lead sends message (SMS / Instagram / Facebook)
        ↓
GoHighLevel fires webhook
        ↓
Supabase Edge Function
  - Identifies the client
  - Queues the message
  - Triggers the Trigger.dev task
        ↓
Trigger.dev (this repo)
  - Waits out the debounce window
  - Groups messages from the same contact
  - Sends grouped message to n8n
  - Receives AI reply
  - Forwards reply to GHL
        ↓
n8n
  - Runs the AI agent
  - Reads setter prompt and chat history
  - Returns structured reply
        ↓
GoHighLevel sends reply to lead
```

Each client also has their own Supabase project (for leads, chat history, prompts). n8n reads and writes to it. This repo does not manage client Supabase projects directly.

---

## What's In This Repo

```
1prompt-os/
├── src/trigger/
│   ├── processMessages.ts     ← core DM flow: debounce → n8n → GHL reply
│   ├── runAiJob.ts            ← AI generation: setter config, prompt editing
│   ├── sendFollowup.ts        ← scheduled follow-up sequence
│   ├── runEngagement.ts       ← engagement automation
│   ├── executeWorkflow.ts     ← GHL workflow node execution
│   └── placeOutboundCall.ts   ← outbound call triggering
├── supabase/
│   └── schema.sql             ← full platform database schema (run once)
├── trigger.config.ts          ← Trigger.dev project config
├── package.json
└── .env.example               ← all required environment variables
```

---

## What You Need

Before you start, you need accounts on all five services:

| Service | Purpose |
|---|---|
| **GoHighLevel** | CRM — sends webhooks when leads message, receives AI replies |
| **Supabase** | Platform database + Edge Functions (the webhook API layer) |
| **Trigger.dev** | Runs the background tasks in this repo |
| **n8n** | Runs the AI agent (your text engine workflows) |
| **OpenRouter** | LLM API used by n8n and Trigger.dev for AI generation |

You also need a second Supabase project per client (for their leads, chat history, and prompts).

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values. These same variables must also be set in your Trigger.dev dashboard under Environment Variables.

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API |
| `TRIGGER_SECRET_KEY` | Trigger.dev Dashboard → API Keys → Production |

---

## High-Level Setup Steps

See [SETUP_OVERVIEW.md](./SETUP_OVERVIEW.md) for the full map.

---

## This Is Not a Tutorial

This repo gives you the complete source code and database schema. It does not walk you through how to configure each service, wire the webhooks, structure your GHL sub-account, build your n8n workflows, or set up the Lovable frontend.

If you want it fully installed and running — that's what we do. We deploy, debug, monitor, and report on the setters so you don't have to.

**→ [Learn about our fully managed setter service](https://us.1prompt.com/widget/bookings/1prompt-clarity-sessionich4ko)**

---

## License

MIT — free to use, modify, and deploy.
