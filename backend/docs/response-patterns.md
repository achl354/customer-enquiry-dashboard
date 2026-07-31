# Response patterns learned from sales@jdhealthcare.com.au

Grounding notes from reading paired received/sent emails (Sent Items) in the
real mailbox, so the triage system reflects how staff actually work rather
than generic assumptions. This is the reference to use when building the
real AI classifier/reply-drafter (see README Roadmap) — either as a prompt
appendix or few-shot examples.

**Sample size**: an initial pass over ~55 emails, followed by a much larger
validation pass across ~350 emails (Inbox, Archive, and Sent Items spanning
Jan 2025–Jul 2026). The larger pass confirmed the original patterns and
surfaced three categories the first pass missed entirely (returns/credit,
logistics/freight, and formal product complaints), plus the geographic
routing table and signature-evolution note below.

## Standard reply structure (very consistent across staff)

1. Greeting by first name: `Good afternoon/morning [Name],` or `Hi [Name],`
2. `Thank you for contacting us.` — almost universal opening line.
3. Category-specific body (see below).
4. If there was a delay: an apology line — `We sincerely apologize for the
   delay and any inconvenience this may cause. Thank you for your patience
   and understanding.`
5. Close: `Please let me know if you have any questions or require any
   further information.` / `Please feel free to reach out if you need any
   further assistance.`
6. Signature block:
   ```
   Best regards,
   PAULA PERDOMO
   Operations Coordinator
   1300 791 404
   3/22 Beaumont Rd, Mt. Kuring-Gai 2080
   JDHEALTHCARE.COM.AU
   ```

Tone is warm and personal — first names, occasional friendliness ("Happy
Friday!", emoji), not purely transactional. This is a relationship-driven
customer service culture — recurring bilingual/personal flourishes ("Hola
Simon", "Buenos días, hermosa", "Feliz Juernes Henrisito") show the tone is
calibrated per recipient, not just generically warm. A drafter that's too
formal on an internal forward will read as out of character.

**Signature has changed over time** — don't hardcode one title as permanent:
- Jan 2025: "Senior Client Services Executive"
- Most of 2025 – 27 Jul 2026: "Client Services Executive"
- From ~27 Jul 2026: "Operations Coordinator" (current, matches examples below)

A reply drafter should key off the most recent real example at ingestion
time, not a fixed string.

## Category-specific patterns

**PO / ETA requests** — staff check stock/container status internally
*before* replying (see "Internal escalation" below); they don't answer from
the email alone. The reply is per-PO:
- Delivered → "Please note that PO `<number>` was delivered `<date>`. I have
  attached the Proof of Delivery for your reference." (POD is a screenshot/
  doc attachment, not just text.)
- Not yet delivered → "Regarding PO `<number>`, we are expecting to receive
  our container `<timeframe, e.g. 'this Monday or Tuesday'>`. As soon as the
  stock becomes available, we will arrange for the order to be dispatched
  promptly." + apology line.
- Buyer emails often include a structured table: PO number, PO line number,
  product item, supplier product number, **warehouse**, ETA — worth
  extracting warehouse/line number too, not just the PO number, if building
  richer extraction later.

**Equipment faults** — genuine hardware faults are *not* answered directly.
Staff forward internally to Purchasing with a short structured note:
> "The customer is looking for replacement clips for their Levabo Turn All
> system. They advised that the two clips that connect the hoses to the pump
> housing have broken due to frequent use. Could you please check with the
> manufacturer if these clips are available as replacement parts and, if so,
> confirm the price and availability?"

**Important distinction**: a customer sharing that they *already fixed* the
issue themselves, or leaving positive feedback with a minor comment, is a
completely different reply — warm, thankful, addresses the specific detail
(e.g. sizing) directly, no escalation. The "Push Ortho Thumb Brace" thread is
the concrete example: the customer said *"I have sorted my two braces out"*
after earlier positive feedback, and got a reply thanking them and offering
a different plastic-cap size — not an urgent fault escalation. Keyword
matching alone ("digs into", "broken") can't tell these apart; a real AI
classifier needs to weigh sentiment/resolution-status, not just fault
vocabulary.

**Invoice/billing** — staff check tracking/dispatch records and reply with
Proof of Delivery for delivery disputes, or forward to Accounts
(`accounts@jdhealthcare.com.au`) for billing corrections/remittances.

**Quotes/pricing** — if stock is available, send the quote attached; if
backordered, give a specific estimated window (e.g. "last week of
September") with an apology, same as PO/ETA handling.

**Spare part enquiries** — replies are structured with exact fields:
```
Code: PABM-FOOT PLATE NUT
Description: I-MOVE Plastic Nut for Locking Pin on Foot Plate
Price: $2.00 + GST each
```

**Product enquiries / sales leads** — many are *not* answered by the
sales@ team directly. They're forwarded internally to a named specialist
with a one-line intro: *"Could you please assist [name] when you get a
chance?"* — routing depends on topic (lifters/trials → Michael; general
product enquiries → Edan; equipment sourcing/faults → Scott/purchasing).
Only simple factual questions (e.g. cleaning instructions from a manual)
get answered directly by the ops team. Website contact-form enquiries carry
a city tag in the subject — `"[SYDNEY] Enquiry from JD Healthcare Group
Website"` — which maps directly to a territory rep (see routing table
below); "New sales lead for: `<product>` - JD Healthcare Group" subjects are
the same pattern, always forwarded, never answered directly.

**Returns/credit** — distinct from billing disputes: staff confirm the
returned item was received and process a credit note, with **no apology
line** even when the original issue was a billing/ordering error:
> "I can confirm that we have received the returned items and the credit
> note has been processed" (credit note attached)

**Logistics/freight** — consignment redirects, pickup confirmations, and
proof-of-delivery threads with couriers (Steadfast Logistics, PACK & SEND,
TNT, FedEx) are a distinct workflow from a product enquiry — staff
coordinate directly with the courier contact on the thread, not with the
end customer.

**Formal product complaints / adverse events** — a different register from
a routine spare-parts request or fault report. Language is procedural, not
apologetic-first: ask the customer to discontinue use, and capture product
code, LOT number, and expiry before anything else. Routes to a named
quality contact (Andrew Lau in this mailbox), not Purchasing.

**Price-discrepancy holds** — a PO can be "ON HOLD" for a pricing mismatch,
not a stock delay — a materially different instruction to the customer.
Fixed 4-part structure:
> thank-you → "there are some price discrepancies" → itemised corrected
> price(s) → "Kindly update the pricing accordingly and send us an amended
> PO" → "this order is ON HOLD pending an amended PO."

**Genuine engineering faults escalate past internal Purchasing** — one
observed thread (a lifter's "Overload UP/Down" fault) went directly to the
overseas manufacturer's engineering team, with technical back-and-forth over
firmware/reset procedure — the generic "forward to Purchasing" action is too
coarse for this sub-case; a real fault sometimes needs to go straight to the
manufacturer, not through an internal stock-check step.

## Geographic / territory routing table

Website contact-form enquiries (subject tagged `[CITY]`) and general sales
leads route to whichever rep covers that territory:

| City tag | Routes to |
|---|---|
| SYDNEY | Simon White |
| MELBOURNE | Atul Gupta / Allan Baker |
| ADELAIDE | Miffy Boden |
| PERTH | Edan Hanley / Rhys Hosgood |
| NEWCASTLE | Minh-Thu Cao Xuan |
| AUCKLAND (NZ) | Medix21 — external distributor (Aaron Morgan), not internal staff |

## Internal escalation is the default, not the exception

A large share of "enquiries" in this inbox aren't resolved by the person
reading them — they're triaged to the right internal person first:
- Stock/ETA questions → Purchasing (Scott Borresen/"Scotty")
- Equipment faults/spare parts → Purchasing + manufacturer (or straight to
  the manufacturer's engineering team for a genuine design/engineering fault)
- Formal complaints / adverse events → Andrew Lau (quality contact)
- Sales leads / trial requests / specialised product questions → named
  product specialists, often by territory (see table above) or by product
  type (lifters/trials → Michael Skerl)
- Contract/special pricing → Jamia Vendivel (+ Lauren Langley for the
  ops-facing version)
- Billing/remittances/credit notes → Accounts (`accounts@jdhealthcare.com.au`,
  Janine Emerson)
- Logistics/freight issues → the courier contact directly, not an internal
  routing step

This means the dashboard's "suggested action" is often correctly "route to
X" rather than "reply to customer" — the current rule-based classifier
reflects this now (see `classify.js`), and a future AI drafter should treat
routing as a first-class suggested action, not just reply drafting.

## Known false-positive traps for keyword-only classification

- A refund follow-up with no fault language at all ("I sourced a similar
  product elsewhere, thanks anyway") still needs internal routing ("I will
  pass this to Purchasing for consideration") — easy to miss if only
  scanning for complaint/fault vocabulary.
- Adverse-event complaints often contain **no** "broken"/"fault"/"malfunction"
  words at all — they read like a routine product enquiry unless you check
  for "customer complaint", "discontinue use", "LOT number".
- "ON HOLD" in a subject line is ambiguous by itself — could be a stock
  backorder or a price-discrepancy hold, and the correct customer-facing
  instruction is different for each.
- A courier/logistics thread often carries "URGENT" in the subject and gets
  the priority right by luck (urgent-keyword match), but without a
  dedicated category it gets miscategorized as a product or supplier
  enquiry, which points staff at the wrong next action.
