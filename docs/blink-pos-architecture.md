# Blink POS, Mapped End to End

A single-branch restaurant deployment of **Blink POS** — logged in as `admin@flames.com` and walked through every module in the sidebar. Below: how the system is built, what each module does, and how an order actually flows through it.

**Account:** Flames by The Indus, Branch 1152

| Stack | Rendering | Auth | Edge | Roles seen | Module groups |
|---|---|---|---|---|---|
| Laravel + Blade | Server-side | Session + CSRF | Cloudflare | Admin, Pulse | 9 |

---

## How a request actually travels

No SPA framework, no JSON API bundle shipped to the browser — the login page and every module render as plain server-built HTML. That's why a plain login form (email, password, CSRF token) was enough to get in.

```
Browser              Cloudflare            Laravel app                Branch scope                 Blade views
  │  email/pass/CSRF    │  edge proxy          │  validates creds,        │  session pinned            │  each sidebar link
  │  → POST /login  ──> │  (TLS/DDoS layer, ─> │  opens laravel_session ─>│  to one branch for    ───> │  is its own page:
  │                     │   not the app)        │  cookie, redirects       │  every next screen          │  /item, /category,
  │                     │                        │  to /pos-home            │  ("Flames by The Indus")    │  /invoice, /reports…
```

---

## The module atlas

Everything in the left sidebar, grouped the way the product groups it. `code` tags are the actual routes behind each screen.

### Order Management
The POS terminal itself, plus everything that touches a live order.
- Create New Order — the till screen cashiers use — `/invoiceCreate`
- Order list & history — `/invoice`
- Order Reversal — voids/refunds a completed order — `/invoiceReversal`
- Dine-In tables & waiter assignment
- Kitchen Display Screen + Station Screen (KDS)
- Shift Schedule — cashier shift open/close — `/branch_shift`

### Menu Management
What the branch sells, and how it's presented on the till.
- Categories — `/category`
- Items — `/item`
- Variations (sizes, add-ons) — `/variation`
- Deals / combos — `/deal`
- Branch-wise toggle — show/hide items per branch — `/branch_category_index`

### Inventory Management
Recipe-level stock tracking, one layer below the warehouse.
- Sub Recipe — `/sub_ingredient`
- Ingredients Count — `/branch_ingredient`
- Branch Stock Count — `/branch_item`

### Warehouse Management
Procurement and multi-location stock — the supply side of the kitchen.
- Ingredient Category — `/ingredientcategory`
- Ingredients master — `/ingredient`
- Suppliers — `/supplier`
- Purchase Orders — `/purchase_order`
- Ingredient Request (branch transfer) — `/transfer-orders/branch`
- Stock Request — `/transfer-orders_stock/branch`
- Warehouse Ingredients & Warehouse Stock
- Air Inventory — `/air-inventory`

### Analytics & Report
Everything that turns orders back into decisions.
- Dashboard — sales KPIs, charts, live shift view — `/dashboard`
- Customer Data — `/customer`
- System / BI Report — `/reports`, `/bi_reports`
- Branch-Wise Stats — `/branchwise`
- Food Cost Dashboard — `/foodcost-dashboard`
- KDS Dashboard — `/kds-dashboard`

### Sales Channels
Demand sources beyond the walk-in counter.
- Marketplace — `/marketplace`
- Third-Party Channels (e.g. Foodpanda) — `/channel`
- Offline Riders — own delivery fleet
- Supplier Balance Record — payables view

### Expenses
The branch's own P&L inputs, outside of COGS.
- Expense — `/expense`
- Income — `/income`

### Settings
Org-level configuration — branches, staff, money rules.
- Branches — `/branch`
- User & Roles — `/user`
- Charges (service charge, delivery fee…) — `/charge`
- Credit + Credit Balance Sheet — `/credit`
- Discounts — `/discount`
- Vouchers — `/voucher`
- Branch Devices — POS terminal/printer registry
- Master Settings — see below — `/master_settings`

### Help & Support
- Help & Support — `/help_support`

---

## What the Dashboard actually tracks

Pulled straight from the live analytics dashboard for this branch — the KPI and chart set a manager checks day to day:

Net Sales · Avg Net Sales / Avg Orders · Change vs Last Year · Cancelled Orders · Cost of Waste · Charges collected · Blink Loyalty · Branch Expected Cash · Active Shifts Summary · Customer Insights · Sales by Category · Sales by Channel · Cash / Card / Foodpanda split · Daily Orders trend

---

## Roles & access

Only two roles exist on this account today — access control is role-based, then scoped to a branch on top.

| Role | Seen as | Likely scope |
|---|---|---|
| Admin | role id `2342` | Full access — every module above, all branches, Master Settings |
| Pulse | role id `2343` | Named for the "Pulse" reporting layer — likely a restricted, analytics-facing role |

---

## Inside Master Settings

One screen, many switches — this is where the business rules for the whole branch live.

**Business & branch**
- Restaurant name, brand name, contact info
- Language selection
- Operation start / end time

**POS & ordering behaviour**
- Show images / stock quantity on menu screen
- Manual discount rules
- Special instructions per order item
- Prompt for customer details on order creation

**KOT & printing**
- Master KOT for open / complete / rejected orders
- Separate KOT per variation item
- KOT on delivery / takeaway, KOT QR code

**Shift & cash**
- Manual drawer balance entry at shift end
- End shift with/without pending orders
- Reset branch inventory counts daily

**Tax & payments**
- Apply tax pre/post discount
- Tax on Blink-online vs third-party orders
- Card reference number required for card payments

**Integrations & alerts**
- Foodpanda orders land as "Pending" by default
- Sound notifications for new orders
- Reason required when a cashier marks item waste

---

## The order lifecycle, A to Z

This is the thread that actually connects every module above — one order, walked through the whole system.

1. **Menu is defined** — Category → Item → Variation → optional Deal, each toggled per branch.
2. **Shift is opened** — cashier starts a shift with an opening drawer balance under Shift Schedule.
3. **Order is created** — dine-in (table + waiter), takeaway, delivery, or a Marketplace / third-party channel order lands here.
4. **KOT fires to the kitchen** — Kitchen Display Screen / Station Screen picks it up per Master Settings' KOT rules.
5. **Payment & charges settle** — cash / card / voucher / credit / discount / service charge all apply against the Invoice.
6. **Stock depletes** — Item → Sub Recipe → Ingredients Count decrements branch inventory automatically.
7. **Warehouse replenishes** — low stock triggers a Purchase Order to a Supplier, or an Ingredient/Stock Request between branches.
8. **Everything rolls into reporting** — Dashboard, Food Cost Dashboard, BI Report and Branch-Wise Stats all read from this same order trail.

---

**Scope of this walkthrough:** read-only exploration of the account's own screens using the credentials supplied — no data was created, edited, or deleted. No password, session token, or cookie is stored in this document. This deployment appears to be single-branch ("Flames by The Indus-Branch") with one restaurant brand configured; multi-brand and multi-branch fields exist in Settings but aren't populated yet.

*Blink POS · exploration for admin@flames.com · 19 Aug 2026*
