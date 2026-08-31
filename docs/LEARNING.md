# What Mockingbird learns, and how it stays out of the way

Mockingbird gets better the more someone uses it. Week one it fixes filler
words. Week four it spells their neighbourhoods right, writes their sign-off
the way they write it, and knows that "the Chens" means the contact in the CRM.

That only works if it remembers — so this page says exactly what is kept, what
is done with it, and how anyone can look at or erase their own.

## The two things that get stored

**1. The event log** (`mockingbird_events`). One row per dictation, per
command, per action executed:

| Column | What's in it |
|---|---|
| `created_at`, `user_id`, `app` | when, who, what they were working in |
| `kind` | `dictation` · `action` · `execute` |
| `raw_text` | what the recognizer heard |
| `output_text` | what went in at the cursor, or what the action did |
| `actions` | the structured commands, with their fields |
| `connector`, `status` | which system it hit, and whether it worked |
| `duration_ms`, `meta` | timings, model, mode |

**Raw audio is never stored.** Not to save space — the transcript gives you
everything useful, and voice recordings are a liability nobody asked for.

**2. The profile** (`mockingbird_profiles`). Every so often, one person's recent
events are read back and distilled into a short working profile:

- **How they write** — sentence length, formality, how they open and close
- **Phrases they use** — verbatim, so their voice survives the polish
- **Vocabulary** — streets, brokerages, client names to stop mishearing
- **People they mention often**
- **How they work** — their follow-up rhythm, what they lead with, how they move a deal along
- **Preferences** they've stated

That profile is injected into the formatting and action prompts. It is the
whole reason the text comes out sounding like them, and the reason "call the
Chens Monday" finds the right contact on the first try.

## The rules the distiller works under

Written into the prompt, not just the docs:

- Only what is **directly evidenced** in their own transcripts. No speculation.
- **Work only**: how they write, who they deal with, how they run their process.
- **Never** health, beliefs, politics, personal finances, protected traits, or
  gossip about third parties.
- Short. It is a cheat sheet, not a dossier.
- Nothing goes in that we would not show the person it describes — which is the
  point of the next section.

## Anyone can read and erase their own

Desktop app: **Settings → What it's learned**. The whole profile, in plain
language, with **Update now** and **Erase what it knows**. The checkbox at the
top turns learning off entirely.

Same thing over HTTP:

```
GET    /api/profile?user=erik     what it has learned
POST   /api/profile {user}        rebuild it now
DELETE /api/profile?user=erik     erase it
```

Per-request opt-out: send `learn: false` and that utterance is handled and
forgotten. Deployment-wide: `MOCKINGBIRD_LEARNING=off`. With no Supabase
configured at all, none of this exists — Mockingbird works exactly the same, it
just starts fresh every time.

## Be straight with people about it

The learning should feel invisible in the product — no dashboards nagging you,
no "I noticed that…", just text that comes out sounding more like you each
week. Invisible in the interface is not the same as secret:

- **Tell agents their dictations are logged**, in onboarding, in one sentence.
  Everyone already assumes their CRM logs their work; nobody likes finding out
  afterwards.
- Point them at Settings → What it's learned. Anything they can read and delete
  themselves stops being creepy.
- If a jurisdiction or contract makes transcript retention awkward, run without
  Supabase, or with `MOCKINGBIRD_LEARNING=off`, and Mockingbird still does its
  main job.

## What the team can learn from it

The event log is a genuine picture of how the business runs by voice — and it
should be used for coaching, not surveillance. Say so out loud, then use it.

```sql
-- Who is actually using it, and how much typing it replaced
select * from mockingbird_daily_usage order by day desc;

-- What people are doing by voice
select connector, actions->0->>'name' as action, count(*)
from mockingbird_events where kind = 'execute'
group by 1, 2 order by 3 desc;

-- Where it fails them — the fastest product feedback you will get
select output_text, count(*)
from mockingbird_events where kind = 'execute' and status = 'error'
group by 1 order by 2 desc;

-- Words it keeps getting wrong: candidates for the shared dictionary
select raw_text, output_text from mockingbird_events
where kind = 'dictation' and raw_text is distinct from output_text
order by created_at desc limit 200;
```

Two things worth building on top, in order of payoff:

1. **A shared dictionary.** Mishearings that repeat across agents are the same
   twenty proper nouns. Feed them back to everyone.
2. **Follow-up coverage.** Compare open houses logged against follow-up tasks
   created. That gap is a coaching conversation with evidence in it.

## Access

Only the API functions can read or write these tables — they hold the service
key, RLS is on, and no browser or desktop client ever touches Supabase
directly. Anyone with the service key can read everyone's transcripts, so treat
it like payroll data: on the deployment, and nowhere else.
