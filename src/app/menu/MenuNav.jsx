'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './menuNav.module.css';

/*
 * The section strip: eight stops, nine once there is a second branch. "Add" lives on each list
 * as its own button, where a person expects it once the list is in front of
 * them. Prefix matching, so /menu/items/abc lights "Dishes"; the dish list
 * itself is the section root and matches exactly.
 */
/*
 * Branch prices earns a stop only when there is a second outlet to differ
 * from the first. With one branch the menu price IS the price everywhere, and
 * a tab whose only destination is a page saying so is furniture — the same
 * rule the rail's branch switcher follows.
 */
const branchStop = ['/menu/branches', 'Branch prices'];

const SECTIONS = [
    ['/menu', 'Dishes', true],
    ['/menu/categories', 'Categories'],
    ['/menu/variations', 'Sizes & Variations'],
    ['/menu/modifiers', 'Modifiers'],
    ['/menu/recipes', 'Recipes'],
    ['/menu/sub-recipes', 'Sub-recipes'],
    ['/menu/deals', 'Deals'],
    ['/menu/ingredients', 'Ingredients'],
];

// The dish editor pages belong to the Dishes stop.
const ALIASES = { '/menu/items': '/menu' };

export default function MenuNav({ branchCount = 1 }) {
    const pathname = usePathname();
    const sections = branchCount > 1
        ? [SECTIONS[0], branchStop, ...SECTIONS.slice(1)]
        : SECTIONS;
    const current = Object.entries(ALIASES).find(([p]) => pathname.startsWith(p))?.[1] || pathname;

    return (
        <nav className={`${styles.strip} no-print`} aria-label="Menu management">
            {sections.map(([href, label, exact]) => {
                const active = exact
                    ? current === href
                    : current === href || current.startsWith(`${href}/`);
                return (
                    <Link
                        key={href}
                        href={href}
                        className={`${styles.tab} ${active ? styles.active : ''}`}
                        aria-current={active ? 'page' : undefined}
                    >
                        {label}
                    </Link>
                );
            })}
        </nav>
    );
}
