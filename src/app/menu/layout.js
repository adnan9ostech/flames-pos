import { query } from '@/lib/db/pool.mjs';
import MenuNav from './MenuNav';

/*
 * Every Menu screen keeps the section strip above it — a nested layout, so
 * moving from the dish list to its recipe swaps the panel below and nothing
 * else. The same shape /accounts and /reports use.
 *
 * The strip's one conditional stop is Branch prices, and the count that
 * decides it is read HERE rather than in the strip: the strip is a client
 * component on every Menu screen, and asking it to fetch would be a round trip
 * per screen for a number that changes about once a year.
 */
const activeBranchCount = async () => {
    try {
        const rows = await query('SELECT COUNT(*) AS n FROM branches WHERE is_active = 1');
        return Number(rows[0]?.n) || 1;
    } catch {
        // A database blip costs the strip one stop, not the whole Menu section.
        return 1;
    }
};

export default async function MenuLayout({ children }) {
    return (
        <>
            <MenuNav branchCount={await activeBranchCount()} />
            {children}
        </>
    );
}
