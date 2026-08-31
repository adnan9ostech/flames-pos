'use client';
import { BadgePercent } from 'lucide-react';
import styles from './DiscountPlans.module.css';

/*
 * What a plan takes off this bill, in whole rupees. Pure — no clock, no
 * network — so the tests can pin it down: the schedule question ("is this
 * plan on offer right now?") is the server's job (applicablePlans); this
 * only answers "given these lines, how much?".
 *
 * Scope decides the base the value works on:
 *   order    — every line (value% of the subtotal, or the fixed amount);
 *   item     — lines whose menu-item id is in plan.item_ids;
 *   category — lines whose category_id is in plan.category_ids.
 * A fixed discount never exceeds its base — "Rs 300 off the biryani" cannot
 * eat into the drinks. min_qty gates on the MATCHING lines' quantity, and
 * max_value caps the result. Rounded like calcTotals rounds, so the rupee
 * the till offers is the rupee settle recomputes.
 */
export const computePlanDiscount = (plan, billItems) => {
    const items = Array.isArray(billItems) ? billItems : [];
    const lineTotal = (i) => (Number(i.price) || 0) * (Number(i.qty) || 0);

    let matching = items;
    if (plan.scope === 'item') {
        const ids = new Set((plan.item_ids || []).map(String));
        matching = items.filter((i) => ids.has(String(i.id)));
    } else if (plan.scope === 'category') {
        const ids = new Set((plan.category_ids || []).map(String));
        matching = items.filter((i) => ids.has(String(i.category_id)));
    }

    const base = matching.reduce((sum, i) => sum + lineTotal(i), 0);
    if (base <= 0) return 0;

    const matchedQty = matching.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
    if ((Number(plan.min_qty) || 0) > matchedQty) return 0;

    const value = Number(plan.value) || 0;
    let rupees = plan.value_type === 'percent'
        ? Math.round((base * value) / 100)
        : Math.min(Math.round(value), Math.round(base));

    if (plan.max_value != null) rupees = Math.min(rupees, Math.round(Number(plan.max_value)));
    return Math.max(0, rupees);
};

/*
 * One-tap chips for the plans the server said are on offer. Tapping hands
 * the till a plain rupee amount with the plan's name as the reason — the
 * order stores money, never the plan, so a later edit to the plan cannot
 * re-price a bill already rung.
 *
 * A plan the bill doesn't qualify for yet (nothing matching, or short of
 * min_qty) stays visible but disabled: the cashier should see the deal
 * exists and what it still needs.
 */
const DiscountPlans = ({ plans, billItems, subtotal, onApply }) => {
    const list = Array.isArray(plans) ? plans : [];
    if (list.length === 0) return null;

    // Never offer more off than the bill itself — the server clamps too,
    // but the chip shouldn't promise a number settle would shrink.
    const billCap = Math.max(0, Math.round(Number(subtotal) || 0));

    return (
        <div className={styles.row} role="group" aria-label="Discount plans">
            {list.map((plan) => {
                const rupees = Math.min(computePlanDiscount(plan, billItems), billCap);
                const usable = rupees > 0;
                const hint = usable
                    ? `Take Rs. ${rupees.toLocaleString('en-PK')} off`
                    : (Number(plan.min_qty) || 0) > 0
                        ? `Needs ${plan.min_qty} qualifying item${plan.min_qty === 1 ? '' : 's'} on the bill`
                        : 'Nothing on this bill qualifies';

                return (
                    <button
                        key={plan.id ?? plan.name}
                        type="button"
                        className={styles.chip}
                        disabled={!usable}
                        title={hint}
                        onClick={() => onApply(plan.name, rupees)}
                    >
                        <BadgePercent size={13} aria-hidden="true" />
                        <span className={styles.name}>{plan.name}</span>
                        {usable && (
                            <span className={styles.amount}>
                                −Rs. {rupees.toLocaleString('en-PK')}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
};

export default DiscountPlans;
