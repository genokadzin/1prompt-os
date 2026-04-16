# Setup Overview

This document describes how the 1Prompt platform is structured, how every service connects, what data flows where, and what you need to configure for the system to work end-to-end.

This is a technical reference — not a step-by-step tutorial. It is intended for developers or technically inclined operators who understand the services involved. Reading through this in full before starting will save you significant time.

---

## Table of Contents

1. [Services Overview](#1-services-overview)
2. [The Full Message Flow](#2-the-full-message-flow)
3. [Supabase — Platform Database](#3-supabase--platform-database)
4. [Trigger.dev — Background Tasks](#4-triggerdev--background-tasks)
5. [GoHighLevel Configuration](#5-gohighlevel-configuration)
6. [n8n — The AI Engine](#6-n8n--the-ai-engine)
7. [Client Supabase Projects](#7-client-supabase-projects)
8. [OpenRouter](#8-openrouter)
9. [Lovable — Frontend Dashboard](#9-lovable--frontend-dashboard)
10. [Environment Variables Reference](#10-environment-variables-reference)
11. [Database Tables Reference](#11-database-tables-reference)
12. [Webhook Payload Reference](#12-webhook-payload-reference)
13. [Common Failure Points](#13-common-failure-points)
14. [Fully Managed Option](#14-fully-managed-option)

---

## 1. Services Overview

The platform is five services. Every single one must be correctly configured for messages to flow through end-to-end. Missing or misconfiguring any one of them will silently break the others.

| Service | Role | Who manages it |
|---|---|---|
| **GoHighLevel** | CRM — receives lead messages, fires webhooks, sends AI replies | Client's GHL sub-account |
| **Supabase (platform)** | Main database + API layer (Edge Functions) | You — one project for the whole platform |
| **Trigger.dev** | Background task engine — debounce, grouping, forwarding | You — this repo |
| **n8n** | AI engine — runs the LLM, reads conversation history, returns reply | You — self-hosted or cloud |
| **OpenRouter** | LLM API gateway | Per-client API key stored in `clients` table |

There is also a second Supabase project **per client** — this is the client's own database that stores their leads, chat history, and setter prompts. n8n reads and writes to this. Trigger.dev reads credentials for it from the `clients` table in the platform database.

---

## 2. The Full Message Flow

This is what happens when a lead sends a message. Every step must work for the reply to arrive.

```
1. Lead sends a message on SMS, Instagram DM, or Facebook
         ↓
2. GoHighLevel detects the new inbound message
   GHL fires a POST webhook to your Supabase Edge Function URL:
   receive-dm-webhook
   
   Query parameters sent by GHL:
   Contact_ID, GHL_Account_ID, Message_Body, Name, Email, Phone, Setter_Number
         ↓
3. Edge Function: receive-dm-webhook
   - Looks up the client in the `clients` table using GHL_Account_ID → ghl_location_id
   - Reads debounce_seconds from `agent_settings` for the given setter slot
   - Inserts the message into `message_queue`
   - Creates or updates a row in `dm_executions`
   - If no Trigger.dev task is currently running for this contact:
       → Triggers the `process-messages` Trigger.dev task
       → Saves the run ID to `active_trigger_runs`
   - If a task IS already running:
       → Does nothing (the running task will pick up the new message after debounce)
         ↓
4. Trigger.dev task: process-messages
   - Immediately creates the lead in `leads` table if they don't exist yet
   - Also upserts lead record into the client's external Supabase project
   - Waits using wait.until() — zero compute cost during the wait
   - After the debounce window expires, fetches all unprocessed messages
     from `message_queue` for this contact
   - Groups them into a single string (newline-separated)
   - Sends the grouped message to n8n as POST query parameters:
     {text_engine_webhook}?Message_Body=...&Lead_ID=...&GHL_Account_ID=...
     &Name=...&Email=...&Phone=...&Setter_Number=...
   - Waits for n8n to respond (up to 10 minute timeout)
         ↓
5. n8n processes the message
   - Receives the message via webhook (reads query params — not JSON body)
   - Looks up the lead's chat history from their Supabase project
   - Reads the setter's system prompt from the client's Supabase project
   - Runs the LLM via OpenRouter
   - Returns a JSON response with one or more message fields:
     { "Message_1": "...", "Message_2": "..." }
         ↓
6. Trigger.dev receives n8n response
   - Validates the response has at least Message_1
   - Forwards the exact JSON response to GHL:
     POST {ghl_send_setter_reply_webhook_url}?Contact_ID={lead_id}
     Body: the raw n8n JSON response
   - Updates last_message_preview in `leads`
   - Marks all processed messages in `message_queue` as processed=true
   - Updates `dm_executions` status to 'completed'
   - Cleans up `active_trigger_runs`
   - Schedules follow-up timer if configured in `agent_settings`
         ↓
7. GoHighLevel receives the reply and sends it to the lead
```

**Critical:** n8n must receive the message as query parameters, not a JSON body. GHL sends them as query params natively and n8n is configured to read them the same way. If you configure n8n to read a JSON body, it will receive nothing.

---

## 3. Supabase — Platform Database

### Project Setup

Create one Supabase project for the entire platform. This is not per-client — it is shared infrastructure.

Run `supabase/schema.sql` in the SQL Editor. This creates all 10 required tables.

Enable Row Level Security (RLS) as appropriate for your setup. The Edge Functions use the service role key and bypass RLS entirely.

### Edge Functions

The Edge Functions are the inbound API layer — they receive webhooks from GHL and trigger Trigger.dev. They are not in this repo. They are deployed via Lovable.

Edge Functions that must be deployed:
- `receive-dm-webhook` — main inbound message handler
- Functions for AI job creation, client config management, and dashboard data

Edge Functions communicate with Trigger.dev using the v1 API:
```
POST https://api.trigger.dev/api/v1/tasks/{taskId}/trigger
Authorization: Bearer {TRIGGER_SECRET_KEY}
Body: { "payload": { ...taskPayload } }
```

To cancel a running task:
```
POST https://api.trigger.dev/api/v2/runs/{runId}/cancel
Authorization: Bearer {TRIGGER_SECRET_KEY}
```

Note: The Trigger.dev API version matters. Use v1 for triggering tasks, v2 for cancelling runs. v3 returns 404.

### Service Role Key

All Trigger.dev tasks and Edge Functions use the Supabase service role key. This key bypasses Row Level Security. Do not expose it in client-side code. Store it only in Trigger.dev environment variables and Supabase Edge Function secrets.

---

## 4. Trigger.dev — Background Tasks

### Why Trigger.dev

Supabase Edge Functions have a maximum execution time of 150 seconds. The full message flow — debounce wait + n8n AI processing — can take up to 10 minutes. Trigger.dev handles long-running tasks and resumes them after waits at zero compute cost using `wait.until()`.

### Setup

1. Create a Trigger.dev account at trigger.dev
2. Create a new project
3. Copy your project ID from Project Settings into `trigger.config.ts`
4. Set environment variables in Trigger.dev Dashboard → Environment Variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
5. Clone this repo, run `npm install` from the root (not from `frontend/`), then deploy with `npx trigger.dev@latest deploy`

For local development: `npx trigger.dev@latest dev`

### Tasks in This Repo

#### `process-messages` — processMessages.ts
The core DM handler. Triggered by the `receive-dm-webhook` Edge Function.

Payload:
```typescript
{
  lead_id: string;           // GHL Contact_ID
  ghl_account_id: string;    // GHL Location ID
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  execution_id: string;      // UUID of the dm_executions row
  debounce_seconds?: number; // from agent_settings, default 60
  setter_number?: string;    // "1", "2", etc.
}
```

What it does internally:
- Creates the lead in `leads` (platform DB) and the client's external Supabase table if new
- Waits using `wait.until()` — the task is paused, not polling
- Fetches all `message_queue` rows where `lead_id` matches, `processed = false`
- Groups messages by joining with newlines
- POSTs to n8n as query params with 10-minute timeout
- Validates n8n response has `Message_1`
- POSTs the response to GHL reply webhook
- Marks messages processed, cleans up active runs
- If `agent_settings` has a follow-up delay configured, triggers `send-followup`

#### `run-ai-job` — runAiJob.ts
Handles all AI generation jobs created from the frontend dashboard.

Payload:
```typescript
{
  job_id: string;
  client_id: string;
  job_type: string;
  messages?: { role: string; content: string }[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" | "text" };
  chunks?: ChunkPayload[];           // for generate-setter-config
  sanitized_parameters?: { key: string }[];
  preserve_selections?: Record<string, unknown>;
}
```

Job types:
- `generate-setter-config` — splits parameters into chunks of 8, fires parallel OpenRouter calls, merges results
- `modify-prompt-ai` — single LLM call to rewrite a full prompt section
- `modify-mini-prompt-ai` — single LLM call to edit one mini-prompt
- `generate-simulation-config` — generates test conversation config
- `generate-simulation-report` — analyzes a completed simulation

The task reads `openrouter_api_key` and `llm_model` from the `clients` table. It does not use whatever the frontend sends for the model — it reads from the database.

Usage is logged to `openrouter_usage` after each job.

#### `send-followup` — sendFollowup.ts
Scheduled by `process-messages` after a reply is sent. Waits the configured delay, then asks the LLM whether to send a follow-up and what to write.

The LLM analyzes the full conversation history and applies configured cancellation conditions (e.g. "lead said goodbye", "lead expressed disinterest"). If the AI decides not to follow up, all pending timers for that contact are cancelled.

If it decides to follow up, it sends via the `send_followup_webhook_url` configured on the client, then writes the message to the client's external Supabase `chat_history` table.

Supports sequences of up to 3 follow-ups (`followup_1_delay_seconds`, `followup_2_delay_seconds`, `followup_3_delay_seconds`).

#### `execute-workflow` — executeWorkflow.ts
Runs GHL workflow automation. Handles node types: `webhook`, `condition`, `delay`, `find_contact`.

#### `run-engagement` — runEngagement.ts
Engagement automation flows.

#### `place-outbound-call` — placeOutboundCall.ts
Triggers outbound voice calls.

### Retry Configuration

All tasks use the retry config in `trigger.config.ts`:
- Max 3 attempts
- Exponential backoff: 1s → 2s → 4s (with jitter)
- `has_error` on `dm_executions` is only set to true after **all** retries are exhausted — never on intermediate failures

---

## 5. GoHighLevel Configuration

### Snapshot

Import the GHL snapshot into your sub-account. The snapshot contains the pipeline structure, automation workflows, and webhook triggers pre-configured.

The snapshot link is available on the course page.

### Webhook Trigger

In your GHL automation, create a trigger that fires when a contact receives an inbound message. The webhook must POST to your `receive-dm-webhook` Edge Function URL.

The following fields must be passed as **query parameters** (not JSON body):

| Parameter | Value |
|---|---|
| `Contact_ID` | `{{contact.id}}` |
| `GHL_Account_ID` | `{{location.id}}` |
| `Message_Body` | `{{message.body}}` |
| `Name` | `{{contact.name}}` |
| `Email` | `{{contact.email}}` |
| `Phone` | `{{contact.phone}}` |
| `Setter_Number` | `1` (or `2` for a second setter slot) |

Missing any of these will cause the task to fail or behave incorrectly.

### Reply Webhook

GHL must also have a webhook that receives the AI reply and sends it to the contact. This is a separate automation in GHL that listens for an inbound webhook POST, reads the message fields from the body, and sends them via SMS/IG/FB.

The reply is sent to:
```
{ghl_send_setter_reply_webhook_url}?Contact_ID={lead_id}
Body: { "Message_1": "...", "Message_2": "..." }
```

GHL reads `Message_1`, `Message_2`, etc. from the body and sends them as individual messages in sequence.

---

## 6. n8n — The AI Engine

### What n8n Does

n8n receives the grouped message from Trigger.dev, loads the setter's system prompt and the lead's conversation history from the client's Supabase project, calls OpenRouter, and returns the reply.

### Webhook Configuration

n8n must be configured to **read query parameters**, not a JSON body. Trigger.dev sends:
```
POST {text_engine_webhook}?Message_Body=...&Lead_ID=...&GHL_Account_ID=...
  &Name=...&Email=...&Phone=...&Setter_Number=...
```

### Required n8n Credentials

- OpenRouter API key
- Supabase credentials for the client's project (for chat history + prompt lookup)

### Expected Response Format

n8n must return a JSON object with this structure:
```json
{
  "Message_1": "First message text",
  "Message_2": "Second message text (optional)",
  "Message_3": "Third message text (optional)"
}
```

At minimum `Message_1` must be present. Trigger.dev validates this before forwarding to GHL. If the response is empty, not JSON, or missing `Message_1`, the task will fail and retry.

### Workflow Files

The n8n workflow JSON files are included in this repo under `frontend/public/workflows/`. There are separate workflows for:
- Text setter (standard SMS/DM replies)
- Appointment booking setter
- Voice setter

---

## 7. Client Supabase Projects

Each client has their own Supabase project — completely separate from your platform project. n8n reads and writes to this. Trigger.dev upserts leads here and writes follow-up messages to chat history.

Run `supabase/client-schema.sql` in each client's Supabase SQL Editor when onboarding them.

### Tables in Client Supabase

| Table | Purpose |
|---|---|
| `leads` | Contact records. Primary key is the GHL Contact_ID (text, not UUID). Trigger.dev upserts here when a new lead is seen for the first time. |
| `chat_history` | Full conversation log. `session_id` = GHL Contact_ID. n8n reads the last 30 messages for context before every LLM call. Follow-up task writes here after sending a follow-up. |
| `text_prompts` | Setter system prompts. n8n reads the row where `card_name = 'Setter-1'` (or `'Setter-2'`, etc.). Written and managed from the 1Prompt dashboard. |

### chat_history Message Format

Each row's `message` column is a JSON object following the LangChain message format:

```json
// Inbound message from the lead
{
  "type": "human",
  "content": "Hey I'm interested",
  "additional_kwargs": {},
  "response_metadata": {}
}

// Outbound reply from the setter
{
  "type": "ai",
  "content": "Hey! Thanks for reaching out...",
  "tool_calls": [],
  "invalid_tool_calls": [],
  "additional_kwargs": {},
  "response_metadata": {}
}
```

n8n must write messages in this exact format for the follow-up task to correctly parse conversation history.

### Credentials Storage

Each client's Supabase credentials are stored in the platform `clients` table:
- `supabase_url` — the client's Supabase project URL
- `supabase_service_key` — the service role key for the client's project
- `supabase_table_name` — the leads table name (defaults to `leads`)

These are used by Trigger.dev to upsert leads and by n8n for all conversation data.

---

## 8. OpenRouter

OpenRouter is the LLM API gateway. It supports all major models (GPT-4, Gemini, Claude, Llama, etc.) through a single API.

Each client has their own OpenRouter API key stored in the `clients` table (`openrouter_api_key`). The model is also configurable per client (`llm_model`).

Default model: `google/gemini-2.5-pro`

Trigger.dev uses OpenRouter for AI generation jobs (`run-ai-job` task). n8n uses the client's OpenRouter key directly in the workflow credentials.

Token usage is logged to the `openrouter_usage` table after every job.

---

## 9. Lovable — Frontend Dashboard

The frontend dashboard is built on Lovable (React + TypeScript + Vite + Tailwind + shadcn/ui) connected to Supabase.

The dashboard provides:
- Client management (add clients, configure credentials)
- Setter configuration builder (generate and edit setter prompts via AI)
- Execution history (live view of `dm_executions`)
- Conversation view (reads from the client's Supabase chat history)
- Analytics (message volume, response times, booking rates)
- Follow-up management (view and cancel pending timers)

The Lovable project must be connected to your platform Supabase project. All Supabase Edge Functions are deployed from Lovable.

The frontend source is included in this repo under `frontend/`. It contains the full React app, all Supabase Edge Functions (`frontend/supabase/functions/`), and all SQL migrations (`frontend/supabase/migrations/`).

---

## 10. Environment Variables Reference

### Trigger.dev (set in Trigger.dev Dashboard → Environment Variables)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your platform Supabase project URL. Format: `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — bypasses RLS. Found in Supabase → Project Settings → API |

### Supabase Edge Functions (set as Edge Function Secrets)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Same as above |
| `SUPABASE_SERVICE_ROLE_KEY` | Same as above |
| `TRIGGER_SECRET_KEY` | Trigger.dev production secret key. Found in Trigger.dev → API Keys → Production |

---

## 11. Database Tables Reference

### `clients`
One row per paying client. Everything else is derived from this row.

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `ghl_location_id` | text | Maps GHL webhook to this client. Must match `GHL_Account_ID` sent by GHL |
| `text_engine_webhook` | text | n8n webhook URL. Trigger.dev sends messages here |
| `ghl_send_setter_reply_webhook_url` | text | GHL webhook that receives the AI reply and sends it to the lead |
| `send_followup_webhook_url` | text | Separate webhook for follow-up messages |
| `debounce_seconds` | integer | Default debounce window. Can be overridden per setter in `agent_settings` |
| `openrouter_api_key` | text | Client's OpenRouter API key. Used by `run-ai-job` task |
| `llm_model` | text | Model identifier (e.g. `google/gemini-2.5-pro`) |
| `supabase_url` | text | Client's own Supabase project URL |
| `supabase_service_key` | text | Service role key for client's Supabase project |
| `supabase_table_name` | text | Leads table name in client's Supabase (default: `leads`) |

### `agent_settings`
Per-setter-slot configuration. One row per setter per client.

| Column | Type | Description |
|---|---|---|
| `client_id` | uuid | References `clients.id` |
| `slot_id` | text | `Setter-1`, `Setter-2`, etc. Must match the `Setter_Number` sent by GHL |
| `response_delay_seconds` | integer | Debounce window for this setter slot |
| `followup_1_delay_seconds` | integer | Seconds after reply before first follow-up fires. 0 = disabled |
| `followup_2_delay_seconds` | integer | Seconds after first follow-up before second. 0 = disabled |
| `followup_3_delay_seconds` | integer | Seconds after second follow-up before third. 0 = disabled |
| `followup_max_attempts` | integer | Total follow-up attempts allowed (1–3) |
| `followup_instructions` | text | Instructions the LLM uses when writing follow-ups |
| `followup_cancellation_instructions` | text | Semicolon-separated conditions that cancel the follow-up (e.g. `lead said no ; lead booked a call`) |

### `message_queue`
Temporary message buffer during the debounce window.

| Column | Type | Description |
|---|---|---|
| `lead_id` | text | GHL Contact_ID |
| `ghl_account_id` | text | GHL Location ID |
| `message_body` | text | Raw message content |
| `channel` | text | `sms`, `instagram`, or `facebook` |
| `processed` | boolean | Set to true after Trigger.dev groups and sends the message |

### `dm_executions`
Live execution log. One row per contact session. The frontend dashboard reads this.

| Column | Type | Description |
|---|---|---|
| `status` | text | `waiting` → `grouping` → `sending` → `completed` / `failed` |
| `stage_description` | text | Human-readable current stage (shown in dashboard) |
| `resume_at` | timestamptz | When the debounce wait ends — used for live countdown in UI |
| `grouped_message` | text | The final combined message sent to n8n |
| `setter_messages` | jsonb | Array of reply messages returned by n8n |
| `has_error` | boolean | True only after all retry attempts are exhausted |

### `followup_timers`
Tracks scheduled follow-up attempts.

| Column | Type | Description |
|---|---|---|
| `status` | text | `pending` → `firing` → `fired` / `cancelled` / `failed` |
| `fires_at` | timestamptz | When the follow-up is scheduled to fire |
| `decision` | text | `sent` or `cancelled` (set by AI) |
| `decision_reason` | text | The AI's explanation for its decision |
| `followup_message` | text | The message that was sent |
| `raw_exchange` | jsonb | Full LLM request + response (for debugging) |

### `ai_generation_jobs`
Job queue for AI generation from the dashboard.

| Column | Type | Description |
|---|---|---|
| `job_type` | text | `generate-setter-config`, `modify-prompt-ai`, `modify-mini-prompt-ai`, etc. |
| `status` | text | `pending` → `running` → `completed` / `failed` |
| `messages` | jsonb | LLM messages array sent to Trigger.dev |
| `result` | jsonb | Completed output — frontend reads this when `status = completed` |

### `error_logs`
All errors from all tasks are logged here with full context.

| Column | Type | Description |
|---|---|---|
| `error_type` | text | Machine-readable error category |
| `error_message` | text | Full error message |
| `context` | jsonb | Task-specific context (lead_id, run_id, etc.) |
| `severity` | text | `error`, `warning`, `info` |

---

## 12. Webhook Payload Reference

### GHL → receive-dm-webhook (query params)

```
POST https://your-project.supabase.co/functions/v1/receive-dm-webhook
  ?Contact_ID=abc123
  &GHL_Account_ID=loc_xyz
  &Message_Body=Hey+I%27m+interested
  &Name=John+Smith
  &Email=john@example.com
  &Phone=%2B14155551234
  &Setter_Number=1
```

### Trigger.dev → n8n (query params)

```
POST {text_engine_webhook}
  ?Message_Body=Hey+I%27m+interested
  &Lead_ID=abc123
  &GHL_Account_ID=loc_xyz
  &Name=John+Smith
  &Email=john@example.com
  &Phone=%2B14155551234
  &Setter_Number=1
```

### n8n → Trigger.dev (JSON response body)

```json
{
  "Message_1": "Hey John! Thanks for reaching out.",
  "Message_2": "Are you available for a quick call tomorrow?"
}
```

### Trigger.dev → GHL reply webhook

```
POST {ghl_send_setter_reply_webhook_url}?Contact_ID=abc123
Content-Type: application/json

{ "Message_1": "Hey John! Thanks for reaching out.", "Message_2": "..." }
```

---

## 13. Common Failure Points

These are the areas where most setups break. Listed not as solutions but as areas to investigate when things don't work.

**Messages received but no task triggered**
The `receive-dm-webhook` Edge Function could not match `GHL_Account_ID` to a `ghl_location_id` in the `clients` table. The values must match exactly.

**Task runs but n8n receives nothing**
n8n is configured to read the JSON body instead of query parameters. Or the `text_engine_webhook` URL stored in `clients` is wrong.

**n8n responds but GHL does not send the reply**
The `ghl_send_setter_reply_webhook_url` is wrong, or the GHL automation that reads the reply webhook is not set up correctly, or the response format from n8n does not include `Message_1`.

**Follow-ups never fire**
`followup_1_delay_seconds` and `followup_max_attempts` must both be greater than 0 in `agent_settings`. The `send_followup_webhook_url` must be set on the client row.

**AI generation jobs stay in `pending`**
The Edge Function that triggers `run-ai-job` is not passing the correct `TRIGGER_SECRET_KEY`, or the Trigger.dev task deployment has not completed.

**Lead data not appearing in client Supabase**
`supabase_url`, `supabase_service_key`, and `supabase_table_name` on the `clients` row are wrong or the table does not have the expected columns.

---

## 14. Fully Managed Option

Setting up and maintaining this stack requires ongoing configuration, monitoring, prompt engineering, and debugging across five interconnected services. Most people who attempt a self-hosted setup spend weeks getting to a working state, and further time maintaining it as GHL, n8n, and model APIs change.

The fully managed service includes:
- Complete deployment of all five services for your business
- Setter prompt engineering and configuration
- Ongoing monitoring and error resolution
- Model and workflow updates as AI capabilities improve
- Reporting on setter performance

**→ [Learn about our fully managed setter service](https://us.1prompt.com/widget/bookings/1prompt-clarity-sessionich4ko)**
