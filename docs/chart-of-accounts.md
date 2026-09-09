# Chart of accounts — what was loaded, and what the accountant should look at

> 3 Sep 2026. Source: `Flames - Chart of Accounts 2.xlsx`, 82 lines, from the
> restaurant's accountant. Loaded by `mysql/migrations/018_chart_of_accounts_v2.sql`.
> **Send this page back to him** — the questions at the bottom are for him.

## Checked first: the file itself

**There are no formulas in it.** Every one of the 492 cells is literal text —
no `=`, no defined names, no links to other workbooks. So there is nothing in
the spreadsheet that can silently compute the wrong number. What it has instead
are four data errors, listed below.

## Errors found in the file

**1. Eight sub-accounts point at a parent that does not exist.** Rows 8010–8080
(Rent, CAM, Licences, Insurance, Professional Fees, Bank Charges, POS
Subscriptions, Security) all carry `Parent Account = "Administration"`. The
parent account is 8000 **Occupancy and Administration**. There is no account
called "Administration". Imported into QuickBooks as it stands, those eight
either fail or silently create a second, empty parent — and the Occupancy
subtotal then reads zero on every P&L. *Loaded here under the real parent.*

**2. 4095 Aggregator Commission is numbered in the income block.** It is typed
`Cost of Goods Sold`, which is right, but numbered 4095, which files it under
revenue on anything that groups by the leading digit. **Renumbered 5085.**

**3. 3000 Director's Current Account is typed "Opening balance Equity".** In
QuickBooks that is a specific system account the software owns and uses to
absorb unbalanced opening entries. A director's current account is an ordinary
equity account and posting to it through Opening Balance Equity will make the
opening entries impossible to unpick later. **Loaded as plain equity, with a
separate 3900 Opening Balance Equity beside it.**

**4. Several Detail Types are not QuickBooks values.** They will be rejected or
silently defaulted on import. `Taxed paid` (8030) should be *Taxes Paid*;
`Security and Serviliance` (8080) is misspelled and is not a detail type at all;
`Communication` (7040), `Supplies` (7050/7095) and `Building Services
Maintenance` (8020) do not exist — the nearest real ones are *Utilities*,
*Supplies & Materials* and *Repairs & Maintenance*. `Service fee income` and
`Discounts Refunds Given` are written *Service/Fee Income* and
*Discounts/Refunds Given*. Spacing is inconsistent in four more
(`OtherBusinessExpenses`, `BankCharges`, `OtherMiscExpense`).
**Detail Type is a QuickBooks field with no equivalent here, so none of this
affects the POS — but it will break his import.**

## The one change that is not cosmetic

**4090 Discounts is filed under CONTRA REVENUE, not REVENUE.**

The income statement negates that category (`src/lib/accounts/statements.mjs`).
Left in REVENUE a discount would be **added** to sales instead of subtracted,
and the P&L would overstate revenue by twice every discount given. His file has
it as a sub-account of Revenue marked "(contra)", which is correct in
QuickBooks; here it needs its own category to get the same treatment.

## Structure: his parents became our categories

This chart is flat — it has no parent/child link — so his eight parent accounts
are held as **categories** instead. Nothing is lost; the grouping is identical
on every report:

| His parent | Category here |
|---|---|
| 4000 Revenue | REVENUE (+ CONTRA REVENUE for 4090) |
| 5000 Cost of Sales | COST OF GOODS SOLD |
| 6000 Labour Expenses | LABOUR EXPENSES |
| 7000 Direct Operating Expenses | DIRECT OPERATING EXPENSES |
| 7500 Sales and Marketing | SALES AND MARKETING |
| 8000 Occupancy and Administration | OCCUPANCY AND ADMINISTRATION |
| 9000 Non-Operating Expenses | NON-OPERATING EXPENSES |
| 1500 Fixed Assets | FIXED ASSETS |

The parents themselves are not loaded as accounts. A parent with children is
not posted to in QuickBooks either, so nothing is lost and nothing can be
mis-posted to a header.

## Fifteen accounts his chart does not have, and why they are here

Not opinions about his chart. Most of these are pointers the software requires
by name and will not start without; the rest are distinctions the till has to
make when it posts. All are numbered inside his own series, so his structure is
untouched. **These are the rows to add to his QuickBooks file.**

| Added | Why |
|---|---|
| **1005 Petty Cash** | carries a posting from before the changeover |
| **1115 Accounts Receivable — City Ledger** | company accounts. His 1110 is *aggregator* receivable, which is a different debtor |
| **1130 Guest Ledger (Open Bills)** | the control account every unpaid bill sits in until it settles. Without it an open tab has nowhere to be |
| **2005 Accounts Payable — Sundry** | non-supplier bills. His 2000 is the supplier control and the software resolves them separately |
| **2090 Suspense — Unmapped Postings** | where a posting goes when nothing is mapped, so a sale is never lost |
| **3010 Director's Drawings** | cash handed over at day close leaves through here |
| **3900 Opening Balance Equity** | see error 3 |
| **4070 Service Charge Income** | the 5% dine-in service charge. Nothing in his chart receives it |
| **4075 Delivery Fee Income** | a delivery charge on the bill is not food revenue |
| **4900 Other Income** | income that is not food, beverage or a charge |
| **3100 Retained Earnings** | prior years' profit. His chart has equity but no reserve |
| **7098 Delivery Rider Cost** | own riders. His 4095/5085 is aggregator commission, a different cost |
| **7099 Cash Over and Short** | every drawer variance posts here. Required |
| **8065 Card Processing Fees** | separated from bank charges so card cost is readable |
| **8090 Sundry Expenses** | the fallback expense account |

**One more difference, which is not an addition:** his **5000 Cost of Sales** is
a parent account. Here it is loaded as a real, postable account — it is where
the till posts recipe cost per order as a single figure, because it cannot split
one plate of karahi across his 5010–5099 ingredient accounts at the moment of
sale. His 5010–5099 remain, for purchases and manual entries. See question 3.

## Eight of the old accounts were retired

Switched off, not deleted — they keep their history and still appear on a trial
balance covering the days they were posted to. None carried a balance.

Cash in Safe (merged into 1000), Advances to Staff, Security Deposits, Tips
Payable, Dessert Sale, COGS — Beverage, Wastage and Spoilage & Expiry (both
merged into 5099 Inventory Variance and Wastage).

## The numbering changed, and this is the important part

The old chart used ChowPOS's series: **1 asset, 2 liability, 3 income, 4
expense, 5 equity**. His file uses the standard one every accounting package
uses: **1 asset, 2 liability, 3 equity, 4 income, 5+ expense**.

The app moved to his. Two charts is not a difference of taste, it is a
reconciliation somebody does by hand every month forever. Every account was
renumbered in place, so all 239 existing journal lines, the 25 expense codes and
every internal pointer stayed attached to the same account through the change.

Account numbers are **four digits** now, as his are.

## Verified after loading

- Trial balance: debits 949,409 = credits 949,409. **Balanced.**
- Balance sheet: assets 356,253 = liabilities 192,641 + equity 163,612.
  **Difference: 0.**
- Income statement: the contra-revenue row is negated, gross profit and net
  profit compute.
- 90 active accounts, all four digits, every leading digit matching its group.
- No expense code and no journal line left pointing at a retired account.
- 139 automated tests pass.

**One real break was found and fixed while doing this.** The posting engine
resolved the supplier payables control by looking for an account whose *name*
contained "Suppliers" — the old seed's wording. His chart calls it plainly
"Accounts Payable", so every goods-received note and supplier payment would have
stopped posting **silently**, because those hooks swallow their own errors. It
now resolves by structure (link code + category + lowest number) and can never
be broken by a rename again. The name-matching option was removed from the
helper entirely so it cannot come back.

## Questions for the accountant

1. **Cash in Hand (Till & Safe) is one account (1000).** That makes the nightly
   handover from till to safe an internal movement with no journal entry. If he
   wants the safe visible separately, say so and it becomes two.
2. **Is 3010 Director's Drawings where day-end cash handed to the owner should
   go**, or does he want it in the 3000 current account?
3. **5010–5099 split cost by ingredient category.** The till posts recipe cost
   to 5000 as one figure. Splitting it per sale is possible once ingredient
   prices are loaded — worth doing, or is the split for purchases only?
4. **4040 Food Revenue - Aggregators is marked "(gross)"** with commission at
   5085. Confirm he wants gross revenue with commission as a cost, rather than
   net — it changes the sales figure on the tax return.
5. **The four Detail Type corrections above** are his to make before he imports
   this into QuickBooks.
