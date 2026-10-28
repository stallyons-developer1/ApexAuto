# Review Queue / CRM — manual approve/decline for flagged bookings

When Automation A flags a booking (`status = manual_review`), the customer's info + the check result go
here so a team member can review and **approve** or **decline**. Clean bookings never reach this queue —
only flagged ones.

## Recommended: build it into this app ("our own system")

A lightweight **internal admin dashboard**, backed by the same Supabase database that holds the booking
records. This is the simplest, keeps all data in one place, and needs no third-party CRM.

- **Page:** `/admin/reviews` (password-protected; team only — put it behind Vercel access or a simple
  auth). Never public.
- **Shows** the queue of `manual_review` bookings, newest first. Each row opens a detail view.
- **Detail view** shows:
  - Renter: full name, DOB, email, phone, address (from the verified ID).
  - Booking: vehicle, dates, pickup/drop-off.
  - **Why it flagged:** the `flags[]` from the compliant report + a link to the full report.
  - (Optional) the ICM "extra info" panel (context only — see Automation A).
- **Actions:** **Approve** → `booking.status = bg_clear`, kicks off insurance (Automation B).
  **Decline** → `booking.status = declined_background`, triggers the adverse-action notice + the
  customer "not accepted" email. Every action is logged with the reviewer + timestamp (audit trail).
- **Notify** the team when something lands in the queue (email + optional Slack), so reviews are fast.

## Alternative / additional: push to an external CRM

If Bart prefers his own CRM or a spreadsheet, mirror each flagged booking out to one of:

| Destination | How | Notes |
|---|---|---|
| **Airtable** | REST API — create a row per flagged booking | Easy, has a built-in review UI + status field |
| **Google Sheets** | Sheets API — append a row | Simplest; fine for low volume |
| **HubSpot / Pipedrive** | Create a contact/deal via API | If Imperium already uses a CRM |
| **Bart's own CRM** | Whatever API/DB it exposes | Bart runs a local CRM; if it's to be the destination it needs a way to receive records (API/webhook) |

Recommended pattern: **the internal dashboard is the source of truth** (approve/decline happens there),
and the external CRM is an optional mirror for visibility. Approving/declining in the CRM can write back
via webhook if Bart wants to act from the CRM instead.

## Data to send to the review destination

```jsonc
{
  "booking_id": "bk_...",
  "renter": { "full_name": "", "dob": "", "email": "", "phone": "", "address": "" },
  "booking": { "vehicle": "Corvette C8 Stingray 2024", "pickup": "", "return": "", "location": "" },
  "flags": ["DUI (2023)", "..."],          // from the compliant report
  "report_url": "https://<provider>/report/...",
  "status": "manual_review",
  "submitted_at": "2026-09-24T14:05:00Z"
}
```

## Privacy / retention
- The queue holds PII + a background report — restrict access to the team, encrypt at rest, and set a
  retention/purge policy (e.g. purge declined-booking reports after a fixed window).
- Never expose the report or the flags to the customer. The customer only ever sees "under review" then
  either the normal flow (approved) or the neutral "not accepted" email (declined).
