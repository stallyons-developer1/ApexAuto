# Imperium Rental Verification — Developer Handoff

This folder is the complete spec for finishing the Imperium Luxury Concierge rental-verification
software. Hand it to the developer as-is.

**Live business:** imperiumway.com (WordPress + WooCommerce + iPOSpays)
**Verification app:** https://apex-rental-nu.vercel.app (Vercel project `apex-rental`)
**Vehicle (launch):** Corvette C8 Stingray 2024 — $450/day, $3,000 refundable deposit
**WooCommerce product ID:** 381

## The whole flow in one line

Customer books → **① ID verified** → **② Background/driving check** → **③ Insurance verified** → **④ Payment**.
The checks run **in this order, one at a time**. **① ID, ② background, ③ insurance** are all real gates:
a fail (or a manual decline at ②) stops the pipeline, the customer is not charged, and a "not accepted"
email goes out. A flagged background check doesn't auto-reject — it pauses for a human to decide.

## What's in this folder

| File | What it is |
|---|---|
| `IMPLEMENTATION-PLAN.md` | **Start here.** What's done, what's left, milestones, sequencing, compliance. |
| `data-contract.md` | The exact data each step produces/consumes (the "glue" between agents). |
| `automation-1-background-check.md` | Spec for the background check + flag logic (Automation A). |
| `review-queue-crm.md` | Where flagged bookings go for manual approve/decline. |
| `automation-2-insurance-verification.md` | Spec for the insurance-verification voice agent (Automation B). |
| `insurance-provider-directory.md` | Phone numbers + notes for major US insurers. |
| `../.env` | Every environment variable the app needs (values left empty to fill in). |

## Two automations left to build

- **Automation A — Background check + manual review.** After ID passes, the verified identity is run
  through a compliant background check (Certn). Clean → continue automatically. Flagged (theft, DUI,
  grand theft auto, etc.) → the booking goes to **standby** and lands in a **review queue/CRM** where a
  team member approves or declines. Never auto-rejects.
- **Automation B — Insurance verification.** An AI voice agent confirms, using the policy number, that
  (1) the policy is active and covers the rented vehicle, and (2) the policy is in the renter's name.

## ⚠️ Read the compliance sections

Both automations touch regulated data (FCRA, DPPA, GLBA privacy, TCPA/call-recording). The specs
include the guardrails. **Imperium's attorney must approve the decline criteria and the consent
language before go-live.** This is not optional.
