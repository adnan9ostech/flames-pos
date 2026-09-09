import MenuNav from './MenuNav';

/*
 * Every Menu screen keeps the section strip above it — a nested layout, so
 * moving from the dish list to its recipe swaps the panel below and nothing
 * else. The same shape /accounts and /reports use.
 */
export default function MenuLayout({ children }) {
    return (
        <>
            <MenuNav />
            {children}
        </>
    );
}
