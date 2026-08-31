-- The standing service charge, asked for alongside the tax rates: 5% on
-- dine-in bills, taxable (before_tax), applied automatically at recompute.
-- Settings offers the percentage as a quick edit next to GST; the Charges
-- screen owns the full shape (scope, before/after tax, on/off).
INSERT INTO charges (name, value_type, value, order_types, before_tax, auto_apply, is_active)
SELECT 'Service Charge', 'percent', 5.00, '["dine-in"]', 1, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM charges WHERE name = 'Service Charge');
