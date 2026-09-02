/*
 * Every screen in the app, in one list.
 *
 * The sidebar draws a curated subset of this (the `nav` field decides which
 * rail an entry sits on, and in what order); the search palette indexes all of
 * it, inner pages included. Keeping both off one array is the point — a new
 * screen that is added here is reachable from search the moment it exists,
 * rather than being findable only by someone who already knows the URL.
 *
 * `perm` names the right that opens the screen — the same key the proxy
 * checks — so a rail and a search result can never offer a door the server
 * would slam. An entry with no `perm` needs only a session.
 *
 * `keywords` are what a restaurant actually calls the thing. Nobody walks up
 * to a till thinking "menu-analytics"; they think "best sellers", and the
 * accountant asking for the Z report means Handover. Search matches these as
 * readily as the label, which is most of the difference between a palette that
 * feels psychic and one that makes you guess its vocabulary.
 */
export const NAV_INDEX = [
    // ---- Service: the screens the floor uses during a shift ----
    {
        href: '/pos', label: 'POS', icon: 'Utensils', perm: 'pos',
        section: 'Service', nav: 'primary',
        keywords: 'till order new order sell ring cart checkout billing counter 86 sold out availability',
    },
    {
        href: '/orders', label: 'Orders', icon: 'ClipboardList', perm: 'orders',
        section: 'Service', nav: 'primary',
        keywords: 'history bills invoices receipts past orders void refund reprint',
    },
    {
        href: '/kds', label: 'Kitchen Display', icon: 'MonitorPlay', perm: 'kds',
        section: 'Service', nav: 'primary', newTab: true,
        keywords: 'kds kitchen screen board chef cooking tickets station',
    },
    {
        href: '/customer', label: 'Customer View', icon: 'ExternalLink',
        section: 'Service', nav: 'primary', newTab: true,
        keywords: 'public menu guest qr digital menu customer facing',
    },

    // ---- Reports ----
    {
        href: '/reports', label: 'Reports', icon: 'BarChart3', perm: 'reports',
        section: 'Reports', nav: 'primary',
        keywords: 'analytics dashboard stats overview revenue insights',
    },
    {
        href: '/reports/handover', label: 'Handover Report', icon: 'Receipt', perm: 'reports',
        section: 'Reports',
        keywords: 'z report shift report day report closing handover cashier summary end of day',
    },
    {
        href: '/reports/daily-sales', label: 'Daily Food Sales', icon: 'CalendarDays', perm: 'reports',
        section: 'Reports',
        keywords: 'daily sales food sales per order fbr invoice number day sales',
    },
    {
        href: '/reports/hourly', label: 'Hourly Sales', icon: 'Clock', perm: 'reports',
        section: 'Reports',
        keywords: 'hourly peak busy rush hours staffing by hour trading pattern',
    },
    {
        href: '/reports/item-wise', label: 'Item-wise Sale', icon: 'Boxes', perm: 'reports',
        section: 'Reports',
        keywords: 'items sold dish sales per item quantity sold item wise',
    },
    {
        href: '/reports/menu-analytics', label: 'Menu Analytics', icon: 'PieChart', perm: 'reports',
        section: 'Reports',
        keywords: 'product mix top items best sellers popular dishes categories menu performance',
    },
    {
        href: '/reports/gross-profit', label: 'Gross Profit', icon: 'TrendingUp', perm: 'reports',
        section: 'Reports',
        keywords: 'margin food cost cogs profitability cost of sales gp',
    },

    // ---- Back office: the morning-after reads and the master lists ----
    {
        href: '/drawer', label: 'Cash Drawer', icon: 'Wallet', perm: 'drawer',
        section: 'Back office', nav: 'backoffice',
        keywords: 'cash float till count drawer session paid in paid out variance',
    },
    {
        href: '/dayclose', label: 'Day Close', icon: 'CalendarCheck', perm: 'dayclose',
        section: 'Back office', nav: 'backoffice',
        keywords: 'end of day eod close day start day business day trading day night audit',
    },
    {
        href: '/floor', label: 'Waiters & Tables', icon: 'Armchair', perm: 'menu',
        section: 'Back office', nav: 'backoffice',
        keywords: 'waiters servers staff tables floor plan seating covers areas',
    },
    {
        href: '/expenses', label: 'Expenses', icon: 'ReceiptText', perm: 'expenses',
        section: 'Back office', nav: 'backoffice',
        keywords: 'expense spending costs vouchers payouts bills paid out petty cash',
    },
    {
        href: '/companies', label: 'Companies', icon: 'Building2', perm: 'cityledger',
        section: 'Back office', nav: 'backoffice',
        keywords: 'corporate bill to company accounts clients organisations customers on account',
    },
    {
        href: '/cityledger', label: 'City Ledger', icon: 'BookText', perm: 'cityledger',
        section: 'Back office', nav: 'backoffice',
        keywords: 'btc credit receivable company invoices receipts aging statement',
    },

    // ---- Accounts: the double-entry ledger, modelled on ChowPOS ----
    {
        href: '/accounts', label: 'Accounts', icon: 'Calculator', perm: 'accounts',
        section: 'Accounts', nav: 'backoffice',
        keywords: 'accounting ledger gl books finance bookkeeping accountant',
    },
    {
        href: '/accounts/chart', label: 'Chart of Accounts', icon: 'BookOpen', perm: 'accounts',
        section: 'Accounts',
        keywords: 'chart of accounts account list gl accounts coa account numbers',
    },
    {
        href: '/accounts/ledger', label: 'General Ledger', icon: 'ScrollText', perm: 'accounts',
        section: 'Accounts',
        keywords: 'gl transaction general ledger entries postings journal lines debit credit',
    },
    {
        href: '/accounts/journals', label: 'Voucher List', icon: 'Files', perm: 'accounts',
        section: 'Accounts',
        keywords: 'vouchers journal vouchers jv list transactions',
    },
    {
        href: '/accounts/journals/new', label: 'Add Transaction', icon: 'FilePlus2', perm: 'accounts_admin',
        section: 'Accounts',
        keywords: 'add transaction new journal voucher jv manual entry post journal',
    },
    {
        href: '/accounts/expense-vouchers', label: 'Expense Voucher List', icon: 'ReceiptText', perm: 'accounts',
        section: 'Accounts',
        keywords: 'expense vouchers list draft posted payables',
    },
    {
        href: '/accounts/expense-vouchers/new', label: 'Add Expense Voucher', icon: 'FilePlus2', perm: 'accounts',
        section: 'Accounts',
        keywords: 'add expense voucher new expense record spending pay bill',
    },
    {
        href: '/accounts/expense-categories', label: 'Expense Categories', icon: 'FolderOpen', perm: 'accounts',
        section: 'Accounts',
        keywords: 'expense category list add expense category groups utilities salaries',
    },
    {
        href: '/accounts/expense-codes', label: 'Expense Codes', icon: 'Hash', perm: 'accounts',
        section: 'Accounts',
        keywords: 'expense code list add expense code posting pivot account mapping',
    },
    {
        href: '/accounts/reports', label: 'Account Reports', icon: 'FileSpreadsheet', perm: 'accounts',
        section: 'Accounts',
        keywords: 'account reports financial statements accounting reports',
    },
    {
        href: '/accounts/reports/expenses', label: 'Expense Report', icon: 'FileSpreadsheet', perm: 'accounts',
        section: 'Accounts',
        keywords: 'expense report spending report by category xls pdf export',
    },
    {
        href: '/accounts/reports/payables', label: 'Expense Payables Report', icon: 'FileSpreadsheet', perm: 'accounts',
        section: 'Accounts',
        keywords: 'payables unpaid expenses owed outstanding vouchers creditors',
    },
    {
        href: '/accounts/reports/trial-balance', label: 'Trial Balance', icon: 'Scale', perm: 'accounts',
        section: 'Accounts',
        keywords: 'trial balance tb balances debit credit closing opening',
    },
    {
        href: '/accounts/reports/income-statement', label: 'Income Statement', icon: 'TrendingUp', perm: 'accounts',
        section: 'Accounts',
        keywords: 'income statement profit and loss p&l pnl net profit gross profit revenue',
    },
    {
        href: '/accounts/reports/balance-sheet', label: 'Balance Sheet', icon: 'Landmark', perm: 'accounts',
        section: 'Accounts',
        keywords: 'balance sheet assets liabilities equity financial position',
    },
    {
        href: '/accounts/reports/cash-register', label: 'Cash Register', icon: 'Banknote', perm: 'accounts',
        section: 'Accounts',
        keywords: 'cash register cash book cash movements daily cash in out',
    },
    {
        href: '/accounts/health', label: 'Posting Health', icon: 'HeartPulse', perm: 'accounts_admin',
        section: 'Accounts',
        keywords: 'posting health unposted bills repost ledger gaps missing journals reconcile',
    },
    {
        href: '/charges', label: 'Charges', icon: 'Percent', perm: 'menu',
        section: 'Back office', nav: 'backoffice',
        keywords: 'service charge delivery fee surcharge extra charges',
    },
    {
        href: '/discounts', label: 'Discounts', icon: 'BadgePercent', perm: 'menu',
        section: 'Back office', nav: 'backoffice',
        keywords: 'discount promo offers deals promotions vouchers happy hour',
    },
    {
        href: '/users', label: 'Users', icon: 'Users', perm: 'users',
        section: 'Back office', nav: 'backoffice',
        keywords: 'staff accounts logins permissions roles password reset team',
    },

    // ---- Inventory ----
    {
        href: '/inventory', label: 'Inventory', icon: 'Package', perm: 'inventory',
        section: 'Inventory', nav: 'backoffice',
        keywords: 'stock store levels ingredients warehouse',
    },
    {
        href: '/inventory/masters', label: 'Inventory Masters', icon: 'FileStack', perm: 'inventory',
        section: 'Inventory',
        keywords: 'ingredients units warehouses item master stock items setup',
    },
    {
        href: '/inventory/suppliers', label: 'Suppliers', icon: 'Truck', perm: 'inventory',
        section: 'Inventory',
        keywords: 'vendors supplier payments purchase payables procurement',
    },
    {
        href: '/inventory/recipes', label: 'Recipes', icon: 'ChefHat', perm: 'inventory',
        section: 'Inventory',
        keywords: 'recipe costing bom ingredients per dish build unit cost',
    },
    {
        href: '/inventory/receiving', label: 'Stock Receiving', icon: 'PackageCheck', perm: 'inventory',
        section: 'Inventory',
        keywords: 'grn goods received delivery note receive stock intake purchase receiving',
    },
    {
        href: '/inventory/docs', label: 'Stock Documents', icon: 'ClipboardCheck', perm: 'inventory',
        section: 'Inventory',
        keywords: 'stock docs transfers adjustments counts wastage demand draft',
    },
    {
        href: '/inventory/reports', label: 'Inventory Reports', icon: 'BarChart3', perm: 'inventory',
        section: 'Inventory',
        keywords: 'stock reports variance depleting consumption valuation',
    },

    // ---- Setup ----
    {
        href: '/settings', label: 'Settings', icon: 'Settings', perm: 'settings',
        section: 'Setup', nav: 'backoffice',
        keywords: 'preferences configuration store details printing receipt setup',
    },
    {
        href: '/settings/tax', label: 'Tax Settings', icon: 'Landmark', perm: 'settings',
        section: 'Setup',
        keywords: 'tax fbr gst sales tax rate digital invoicing card rate cash rate ntn',
    },
    {
        href: '/profile', label: 'Profile', icon: 'User',
        section: 'Setup',
        keywords: 'my account change password profile me sign out details',
    },
];

/* The rails the sidebar draws, in the order it draws them. */
export const primaryNav = (perms = []) =>
    NAV_INDEX.filter((e) => e.nav === 'primary' && (!e.perm || perms.includes(e.perm)));

export const backOfficeNav = (perms = []) =>
    NAV_INDEX.filter((e) => e.nav === 'backoffice' && (!e.perm || perms.includes(e.perm)));

/* Everything this person may open — the search index. */
export const searchableNav = (perms = []) =>
    NAV_INDEX.filter((e) => !e.perm || perms.includes(e.perm));
