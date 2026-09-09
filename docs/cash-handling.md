# Cash: the drawer, the count, and the day

> Written 3 Sep 2026, when the carry-forward close shipped. This is the
> operating manual for the physical money — what the screens mean and who does
> what. The code lives in `src/lib/cash/drawer.mjs` (the arithmetic),
> `src/app/drawer/` (the shift) and `src/app/dayclose/` (the day).

## The idea in one line

**The money left in the till when you close is the money in the till when you
open.** Everything below is bookkeeping around that sentence.

## The five numbers

A drawer session is one person's custody of cash for one stretch of service. It
carries five figures and no more:

| | What it is | Where it comes from |
|---|---|---|
| **Opening balance** (float) | The change money already in the till when the shift starts | Carried forward from the last close. Typed only to correct it. |
| **Cash sales** | Bills settled in cash while this drawer was open | The till, automatically. A void writes a negative row, because that refund physically left this drawer. |
| **Paid in / paid out** | Cash that moved for a reason that is not a sale — a change top-up in, a supplier paid out | Entered by hand, with a reason. No reason, no movement. |
| **Expected** | float + cash sales + paid in − paid out − cash expenses | Computed. Nobody types it. |
| **Counted** | What the notes and coins actually add up to | Counted by hand at close. |

**Variance = counted − expected.** Negative is *short*, positive is *over*.
Both are questions. A drawer that is over is not good news — it means a
customer was short-changed, or a sale was never rung up.

## Why the expected figure is hidden until you count

The close panel does not show what the drawer *should* hold until the count is
entered. This is deliberate and it is the single most useful control in cash
handling: if the target is on the screen while you count, a drawer that is two
hundred rupees short gets closed for exactly the right amount, every time, and
you never find out. Count first, then look.

The count is entered **note by note** — how many 5000s, how many 1000s, down to
the coins. The system adds them up. A breakdown that disagrees with the typed
total is refused, because a count that looks precise and is not is worse than no
count at all. Counting as a single lump sum is still allowed for a quiet shift.

## The split at close

When the drawer is counted, the money goes two ways:

- **Left in the drawer** — the change float for tomorrow. This is the number the
  next session opens on.
- **Handed over** — everything else, to the owner, the safe or the bank.

`counted = left in drawer + handed over`, always, and the screen will not let
you leave more behind than you counted.

The standing float — the figure the close proposes to leave — is set once by an
admin on **Settings → Standing cash float**. Zero is a legitimate answer: it
means the till is emptied every night and opens empty.

## When a difference has to be explained

Set on **Settings → Explain a difference over**. A count that misses by more
than this cannot close until somebody types why. The default is zero, so every
difference is explained.

That threshold decides only *when a sentence is required*. The variance itself
is recorded either way, and posted to **Cash Over & Short** in the general
ledger either way. It is not a tolerance for hiding a short.

## The day, on top of the shifts

The trading day is the bigger box. Several drawers can open and close inside
one day (a shift change, a second till), and the day's cash is the roll-up:

- `business_days.opening_cash` — stamped by the **first** drawer to open on the
  day, never overwritten.
- `business_days.closing_cash` — restated by the **last** drawer to close, which
  is correct: the day ends with whatever is in the till when the last one is
  locked.

Yesterday's `closing_cash` is today's `opening_cash`. The Day Close screen shows
the chain, and the history table shows it running back through past days, so a
break in it is visible.

**Day Close will not close the day over an open drawer.** Closing the day means
the takings were never counted and tomorrow opens on a float nobody declared,
which is the hole this all exists to shut. There is an override tick for a
genuine end-of-night decision, and using it is recorded in the audit trail.

**There is no scheduled close.** An earlier draft of this document described one
(`scripts/day-worker.mjs`, driven by the `day_start_time` / `day_end_time`
columns migration 014 added); it was never built, and on 9 Sep 2026 the owner
settled the question: **the day closes when someone presses the button.** A
machine that rolls the calendar past an uncounted drawer is exactly the hole
this document exists to shut, and nobody wanted it.

So the two columns on `store_settings` are read by nothing. They stay — every
migration here is additive and never edited — but they are not a setting, they
are a vestige, and no screen offers them. If a scheduled close is ever wanted,
that is where it would start, and it would need its own answer to the open
drawer before it could be allowed to run.

## The nightly routine

1. Count the drawer — note by note, behind a closed door.
2. Enter the count. Read the variance. Explain it if there is one.
3. Enter what stays in the till. The rest is the handover — count it out and
   hand it over.
4. Close the drawer.
5. Close the day.
6. Read the **Handover report** (`/reports/handover`) — sales, expenses, the
   drawer sessions, what was handed over, what was left, and the day's profit.

## What is deliberately not here yet

- **The handover does not post to the general ledger.** The cash leaving the
  drawer for the owner or the safe is recorded on the session row and shown on
  the reports, but there is no "Cash in Safe" account to move it to. Adding one
  is an accounts-module decision, not a drawer fix, and inventing an account to
  post against would be worse than the gap.
- **Sessions key on the login's role, not the person.** Two cashiers sharing the
  `cashier` login share one drawer. Per-person drawers with a proper handover
  are Phase 2 of the day-end plan.
- **Denominations are not enforced on the float**, only on the count. Opening is
  a single figure.
