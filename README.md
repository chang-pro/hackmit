# BloomKnights — Money Lens (Planning Repo)

Private planning + docs for our BloomKnights hackathon project. **This is NOT the submission repo** — per the rules, the real code repo gets created during the hacking window (10:00 AM Sat). This repo just holds the plan so we're both on the same page.

## Team
- **Dechante** — backend + Gemini engine (`/server`)
- **Christine** — frontend + UI (`/src`)

## The build: Money Lens
Upload a receipt or bank statement → Gemini reads it → spending chart + "$X/year wasted" + **Roast Mode** (Gemini roasts your spending, then gives real advice). Opting into the Bloomberg (Best FinTech) + Gemini (Best Use) sponsor prizes. Target: 1st overall ($1,400 + Meta Quest 3S).

## Read this
- **[WAR-PLAN.md](WAR-PLAN.md)** — full 12-hour plan: hour-by-hour schedule, who builds what, edge cases, the pitch, and the "cut list" if we fall behind.

## How we split the code tomorrow (one repo, no collisions)
```
money-lens/            <- the REAL repo, created after 10 AM
├── server/            <- DECHANTE owns (backend + Gemini)
├── src/               <- CHRISTINE owns (frontend/UI)
│   └── components/
├── App.jsx            <- SHARED — say "editing App" before touching
├── .gitignore         <- FIRST commit, so the API key never uploads
└── .env               <- Gemini key, NEVER committed (shared by text)
```

Rules that stop us breaking each other:
1. You only touch `/src`, Dechante only touches `/server`.
2. `git pull` before you start, `git push` when you finish a chunk. Push every 30–45 min.
3. The Gemini API key never goes in git.

## Git cheat sheet (save your life tomorrow)
```bash
git clone <repo-url>        # once, to get the code
git pull                    # before you start working (get latest)
git add .                   # stage your changes
git commit -m "what I did"  # save a snapshot
git push                    # send it up so the other sees it
```
If git yells about a conflict: don't panic, message the other person, we fix it together (usually means you both edited the same file).
