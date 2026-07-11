---
type: canonical
created: 2026-07-11
updated: 2026-07-11
status: active
tags:
  - hackathon
  - bloomknights
  - money-lens
event_date: 2026-07-11
---

# BloomKnights WAR PLAN — "Money Lens" (Team of 2, React + Tailwind + Gemini)

> [!danger] DQ rules (read first)
> No project code, no repo creation before **10:00 AM**. Nothing after **10:00 PM**. Devpost placeholder by **9:00 PM**. Public repo required. Boilerplate/open-source tools ARE allowed (Vite scaffold + Tailwind + shadcn/ui are legal).

## Context

First hackathon, 12 hours, UCF BA1. Target: 1st overall ($1,400 cash + Meta Quest 3S) + Bloomberg (Best FinTech) + Gemini (Best Use of Gemini API) sponsor prizes. One build, three prize shots.

**The build: Money Lens** — snap/upload a receipt or bank statement → Gemini reads it → spending chart + "$X/year wasted" + **Roast Mode** (Gemini comically roasts your spending, then flips to real advice).

### What the research proved (3 past events from this org + judge interviews)

- **Official scoresheet (their Devpost): Innovation, Technical Skill, Wow Factor, Design & UX, Presentation.** Only 1 of 5 is code. 3 of 5 are feel.
- **GemiKnights (last year, same 12h format, 58 subs):** winners = StorybookAI, swipebites, Eventure. All simple + cute + 2-min-demoable. The technically hard projects lost.
- **Hack Knight Spring 2025 (44 subs): ~12 winner badges.** Roughly 1-in-4 projects won something. Two fintech winners. Winning odds are real if we execute.
- **Knight Hacks VIII (188 subs): 4 fintech winners were ALL "AI financial advisor" chatbots.**
- ⚠️ **Threat: tomorrow's room will be full of Gemini finance chatbots.** Positioning line said out loud: ==This is not a chatbot. It's a camera.== Multimodal receipt-scan + roast = differentiated.
- Judges (Devpost interviews): storytelling is huge, unpolished UI kills, missing requirements kills, 2-person team = advantage (name who built what).

### The demo-killer we found

> [!warning] #1 technical risk
> **Gemini free tier: ~10 requests/MINUTE, ~250/day.** A day of testing + a live judged demo with retries can blow through this. Mitigations in Part 6.

---

## Part 1 — Tonight (legal prep only, ~90 min)

1. **Gemini key insurance (3 layers):** verify existing key in AI Studio playground; create a 2nd Google Cloud project + 2nd API key (separate quota bucket); optional $5 billing → Tier 1 (~100x limits).
2. **MLH registration** (both teammates, before 9 AM): https://events.mlh.com/events/14392-bloomknights
3. **Screenshot the BloomKnights dashboard QR** (check-in, food, workshops).
4. **Demo data kit** (props, not code — desktop + USB + both phones):
   - 2 fake bank statements (1-page PDF, ≤40 rows) with planted comedy: $212 DoorDash month, 4 forgotten subs, 2 gym memberships, $6.50 daily coffee.
   - 3 receipt photos: crisp / crumpled / long grocery. **Test ALL in AI Studio playground tonight.**
   - 1 printed physical receipt to hand a judge.
5. **Cheat-sheet notes file** (notes, NOT a repo): exact commands (`npm create vite@latest`, Tailwind, shadcn init, Express+multer skeleton), Gemini REST call with `responseMimeType: "application/json"` + responseSchema, the extraction prompt, the roast prompt (tone: "playful roast of spending, never mean, never about the person"), Recharts pie snippet.
6. **Pitch draft** (Part 7). Read out loud once.
7. **Pack:** 2 laptops, chargers, backup power strip, tested phone hotspot, photo ID, hoodie, headphones, caffeine, water.
8. **Teammate sync:** lanes (Part 4), Node installed, GitHub ready, both know the pitch + cut order.
9. **Sleep 7+ hours.** Judged at 10:15 PM — pitch quality at hour 13 is decided by sleep.

## Part 2 — Morning logistics + edge cases

- Park **Garage C** (pass TBA — if not posted, buy UCF day permit before leaving; no back-in parking without front plate).
- **9:00 check-in BA1 107** (photo ID + QR). 9:35 opening BA1 119. **Hacking 10:00 AM.**
- Claim a table near power in BA1 239/126/110/107. Judging happens in 239/107 — sit there if allowed so we never move the setup.
- **Sponsor tables 10 AM–6 PM Atrium. Visit Bloomberg + Google/Gemini + OneEthos before noon.** Ask each "What are you hoping to see win your prize?" — write it down, tune pitch to their words, get names.
- Meals BA1 119: Publix subs 12 PM, Costco pizza 6:30 PM. Send ONE person, other keeps building.
- Wristbands on all day.

## Part 3 — Hour-by-hour build (D = Dechante: engine/backend. T = teammate: UI/design)

| Time | D (engine) | T (UI) |
|---|---|---|
| 10:00–10:30 | Create public repo, Vite+React+Tailwind+shadcn scaffold, Express+multer skeleton, `.env` (key NEVER committed — `.gitignore` first commit) | Paper-sketch 3 screens: Upload → Results → Roast. Palette + font |
| 10:30–12:00 | Gemini structured-output call: image/PDF → JSON {categories, subscriptions, fees, wasteItems, totals}. Test with kit. **Cache layer NOW: every success saved to disk by file hash** | Upload screen: drag-drop + picker, loading animation, logo/name |
| 12:00–12:30 | T grabs lunch for both; D visits Bloomberg + Gemini tables | (lunch run) |
| 12:30–2:30 | Waste math ($X/year), 2nd Gemini call: Roast Mode (test safety filters NOW, not 9 PM) | Results screen: Recharts pie, animated dollar counter, waste cards |
| 2:30–4:00 | Wire end-to-end. **4 PM MVP GATE: full flow works on a fake statement.** Missed → cut order fires | Roast screen: chat-bubble reveal → "the real advice" flip |
| 4:00–5:00 | Offline mode: demo runs 100% from cache with wifi OFF. Retry/backoff on 429. Key-switcher | Polish pass 1: spacing, fonts, empty/error states |
| 5:00–5:45 | Record demo video (phone screen-rec fine) | Film + edit together |
| 5:45–6:30 | T grabs dinner; D starts Devpost draft | (dinner run) |
| 6:30–7:30 | **Devpost SUBMITTED (full):** name, description (problem → solution → how Gemini used → impact), screenshots, video, repo link, **✅ opt-in Bloomberg ✅ opt-in Gemini** | Write description with D; screenshot prettiest states |
| 7:30–8:30 | FEATURE FREEZE. Bug hunt on demo path only. Run full demo 5× in a row | Polish pass 2 on the 3 demo screens only |
| 8:30–9:30 | **Pitch rehearsal ×3, timed <5 min, roles assigned.** Rehearse failure lines | Same |
| 9:30–10:00 | Final commit + push before 10 PM. Devpost final check. Nothing after 10:00:00 | Same |
| 10:15–11:00 | At the numbered table, both present, laptop pre-loaded, cached mode ready | Same |

## Part 4 — Lane rules (2-person)

- Commit + push every 30–45 min. Laptop dies → the other clones and continues (share `.env` by USB/text, NEVER git).
- Merge conflicts: **D owns `/server`, T owns `/src/components`.** Shared file (`App.jsx`) = shout before touching.
- Teammate stuck >30 min → swap tasks, don't sink together.
- Never both in food line / bathroom during 10:15–11:00 PM judging.

## Part 5 — Cut order (execute top-down when behind)

1. Webcam live-capture (phone photo → upload instead)
2. PDF statements (photos only — Gemini reads statement *photos* fine)
3. Animations/transitions
4. Roast voice/audio (roast stays text — enough for the laugh)
5. Multiple-category detail view (pie + waste list + roast is the irreducible core)

**NEVER cut:** upload→result flow, pie chart, the $X/year number, Roast Mode text, cache/offline mode, Devpost by 7:30 PM, pitch rehearsal.

## Part 6 — Edge-case matrix ("at all cost")

**API / rate limits (top risk):**
- Cache every success to disk; demo NEVER re-calls a processed file.
- 429 → exponential backoff (2s/4s/8s) → auto-switch to key #2 → fall back to cache.
- Roast blocked by safety filter → prompt "playful, PG, roast the spending not the person"; set safety thresholds; pre-test 12:30.
- Malformed JSON → responseSchema + one retry + cache fallback. UI never shows a raw error.
- Token limits → demo statements capped at 1 page / ≤40 rows.

**Demo-moment failures (10:15–11:00 PM):**
- Wifi dies → phone hotspot (tested tonight) → offline cache mode (tested 4 PM). Works with zero internet.
- Judge's receipt unreadable → *"Thermal receipts fade — here's one from lunch, same flow"* → run cached crisp receipt. Never debug in front of judges.
- Judge has no receipt → hand them OUR printed one.
- Laptop sleeps/updates → never-sleep power settings, notifications off, browser 125% zoom, demo tab pinned, everything else closed.
- Judges show 10:16 or 10:58 → demo-ready the whole window; app sits on upload screen, reset = 1 click.
- Cut off at 5 min → demo starts by minute 1:00; wow moment lands by 2:30.

**Judge Q&A (rehearse 20s each):**
- vs Mint/Rocket Money → *No bank login, no account, no sign-up. Works on paper — a photo IS the interface. Nothing stored.*
- Privacy → *Image processed in memory, never saved. No PII persisted.*
- Why Gemini → *Multimodal + structured output in one call — image in, typed JSON out. That's the whole product.*
- What next → *Bank API sync, trends over time, scam-charge alerts.*
- Who built what → clean split answer.
- Bloomberg judge → lead with impact ($500/yr avg wasted, advisors $200/hr, we're free).
- Gemini judge → lead with API depth (multimodal, responseSchema, two-stage prompting, graceful degradation).

**Rules/compliance traps:**
- Cheat-sheet stays a notes file — never commit pre-10 AM text into the repo.
- Repo public from creation; `.gitignore` before first commit (leaked key in public repo = dead key mid-event).
- Devpost done by 7:30 PM (buffer before the 9 PM stampede).
- Both present at judging or ineligible. Wristbands on.

**Human failures:**
- 8 PM energy crash → caffeine at 7:30.
- Scope-creep → the cut order is one-directional. Features only leave.
- Teammate no-show at 9 AM → solo fallback: cut order pre-executed, more shadcn defaults, pitch solo-rehearsed.

## Part 7 — The 5-minute pitch (front-loaded, both speak)

1. **Hook, 45s (D):** "Last month I spent $212 on DoorDash and had no idea. A financial advisor costs $200 an hour. We built one that lives in your camera. **This is not a chatbot — it's a camera.**"
2. **Live demo, 2 min (T drives, D narrates):** drag the messy statement → pie + "$412/year wasted" reveal → Roast Mode → (laugh) → advice flip. Then the judge-receipt moment (cached fallback ready).
3. **How, 45s (D):** "One Gemini multimodal call: image in, structured JSON out. Second pass writes the roast and advice. React + Node, cached and offline-capable — kill our wifi, it still runs."
4. **Impact, 30s (T):** ~$500/yr lost to forgotten subs; a free advisor for people who can't pay $200/hr, no bank login.
5. **Close, 15s (D):** "A photo becomes a money plan in five seconds. Money Lens."

## Verification gates

- **Tonight:** all 5 demo files parse in AI Studio playground; hotspot tested; MLH done.
- **4:00 PM:** full flow live on fake statement (MVP gate — else cut order fires).
- **4:45 PM:** demo survives wifi OFF (pure cache).
- **7:30 PM:** Devpost fully submitted, both sponsor opt-ins checked, video attached.
- **8:30 PM:** demo runs 5× consecutively without a hiccup.
- **9:30 PM:** pitch ×3 under 5:00; final push done.

## Reference

- Event guide summary + sponsor challenges: see chat / Notion `bloomknights2026`.
- Devpost (submit + opt-in here): https://bloomknights.devpost.com/
