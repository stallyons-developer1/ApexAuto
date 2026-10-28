# Imperium Rental Verification — App + Developer Handover

Verified car-rental booking flow for **Imperium Luxury Concierge** (imperiumway.com).
Customer books the Corvette C8 → verifies ID → (background + insurance automations to build) → pays.

**Live:** https://apex-rental-nu.vercel.app  ·  **Host:** Vercel  ·  **Store:** WooCommerce + iPOSpays on imperiumway.com

---

## 👉 Developer: start with `handoff/`

The complete build plan for the two remaining automations is in **[`handoff/`](handoff/)** —
read `handoff/README.md` first, then `handoff/IMPLEMENTATION-PLAN.md`.

## What's already built (this repo)

```
apex-rental/
├── index.html            Front-end: booking + verification UI (vanilla HTML/CSS/JS)
├── api/                  Vercel serverless functions (Node 18+, CommonJS)
│   ├── didit-session.js  Start Didit ID verification → returns hosted verify URL
│   ├── didit-status.js   Read the Didit result (Approved/Declined/…)
│   └── create-order.js   Create the WooCommerce order → return iPOSpays pay URL
├── deploy.sh             Redeploy to Vercel (no secrets inside)
├── .vercelignore         Keeps helper/secret files off the public deploy
└── handoff/              The written plan for the automations (docs only)
```

**Status:** ID verification (Didit) + order creation (WooCommerce/iPOSpays) work end-to-end.
Background check + insurance verification are currently simulated in `index.html` — those are the two
automations to build (see `handoff/`). There is **no database yet**; the plan recommends adding Supabase
(handoff milestone M1) for booking state + the manual-review queue.

## Run it locally

```bash
npm i -g vercel          # Vercel CLI
vercel dev               # serves index.html + /api functions locally
```

## Environment variables

The app reads all secrets from environment variables — **nothing is hardcoded**. See
[`.env`](.env) for the full list (Didit, WooCommerce, plus the new keys
the automations will need). **Ask Bart for the current values** — they are stored in Vercel
(Project → Settings → Environment Variables), not in this repo.

> Security: the Didit + WooCommerce keys used during development should be **rotated** before go-live.
> Generate fresh WooCommerce REST keys and a fresh Didit key and set them in Vercel.

## Deploy

```bash
VERCEL_TOKEN=xxxxx bash deploy.sh      # redeploys to production
```
(Requires access to Bart's Vercel project `apex-rental`.)
