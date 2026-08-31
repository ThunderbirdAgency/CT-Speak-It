# Mockingbird — Product Descriptions

Ready-to-use copy for menus, feature cards, landing pages, and onboarding.

## One-liner
**Mockingbird** — talk instead of type, anywhere on your computer, and tell your CRM what to do.

## Short (tooltips / feature cards / subtitles)
Mockingbird is your voice everywhere you work — email, documents, messages, and
every field in our apps. Press one key and say it like you'd say it to an
assistant. Clean, professional text lands wherever your cursor is. And when you
say "add Maria Lopez from the open house and remind me to call her Monday," it
shows you what it's about to do, you press Enter, and it's done — in Follow Up
Boss or our CRM. No typing, no cleanup, no clicking through forms.

## Full (landing page / agent onboarding)
**Meet Mockingbird 🐦 — the fastest way to run your business is to say it out loud.**

You just wrapped an open house. Three buyers came through, you've got names and
numbers on a sign-in sheet, and a follow-up forming in your head. Old way:
fifteen minutes of typing into forms tonight — if you remember. Mockingbird
way: hold one key and talk. "Just wrapped the open house at 123 Main Street —
three people came through: John Doe 555-0142, Maria Lopez, maria at gmail dot
com, and Sam Chen — follow up with all of them Monday." Done. Three contacts
saved, the open house logged, the follow-up task on your Monday list — before
you're out of the driveway.

Mockingbird doesn't just hear you, it *understands* you. Say "um" and it
disappears. Correct yourself mid-sentence — "2 o'clock, no wait, 3" — and only
the 3 survives. Spell an email out loud and it assembles it. It learns your
neighborhoods, your clients' names, your way of saying things — and it gets
better every week you use it.

And it's everywhere you work — not just in our apps. It installs on your Mac or
PC and follows you into Outlook, Word, your texts, your listing portal,
anything with a cursor. Every field takes dictation; every action you'd click
through can simply be spoken. When you tell it to do something, it shows you
exactly what it's about to do and waits for you to press Enter — nothing
happens behind your back. Your words stay secure: processed privately, never
used to train anyone's AI, no voice recordings kept.

Talk like an agent. Mockingbird does the typing.

## Internal / technical (team, partners, docs)
Mockingbird is Thunderbird's shared voice layer: one central AI service with
two clients — a Mac/Windows desktop app that works system-wide, and a drop-in
web widget for our own builds. Both give speech-to-polished-text dictation plus
voice-to-action commands (speech → structured objects via Claude), executed
against Follow Up Boss or any product that can describe its endpoints.
Deciding and executing are separate endpoints, with a user confirmation in
between, so nothing is written to a real system unattended. One deployment
serves every app; usage, transcripts, and actions log centrally for analytics,
coaching insight, and per-agent voice profiles that make dictation read like
the person who spoke it.
