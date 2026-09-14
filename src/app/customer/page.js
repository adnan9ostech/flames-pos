'use client';
import { useState, useEffect, useMemo } from 'react';
import { useBrand } from '@/components/Layout/BrandProvider';
import styles from './customer.module.css';
import { getFullMenuData } from '@/lib/dataClient';
import { Soup, Flame, Utensils, Cookie, GlassWater, Plus, Search, LayoutGrid, List } from 'lucide-react';
import { formatNumber as money } from '@/lib/money';
import Image from 'next/image';

// Icon mapping for categories
const CategoryIcon = ({ name, size = 18 }) => {
    const icons = {
        Soup: Soup,
        Flame: Flame,
        Utensils: Utensils,
        Cookie: Cookie,
        GlassWater: GlassWater,
        Plus: Plus,
    };
    const Icon = icons[name] || Utensils;
    return <Icon size={size} />;
};

const VIEW_STORAGE_KEY = 'flames.customerMenuView';

export default function CustomerMenuPage() {
    const brand = useBrand();
    const [menuData, setMenuData] = useState({ categories: [], items: [], modifiers: {} });
    const [activeCategory, setActiveCategory] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    /*
     * Starts on 'grid' rather than reading localStorage during render: this page
     * is server-rendered, and a value only the browser has would make the first
     * client render disagree with the server's. The stored choice is applied in
     * the effect below, which runs well before the menu data resolves — so the
     * cards are only ever painted once, in the right layout.
     */
    const [view, setView] = useState('grid');

    // Load menu data
    useEffect(() => {
        const loadData = async () => {
            try {
                const data = await getFullMenuData();
                setMenuData(data);
            } catch (error) {
                console.error('Error loading customer menu:', error);
            } finally {
                setIsLoading(false);
            }
        };
        loadData();
    }, []);

    // Restore the last-used layout
    useEffect(() => {
        try {
            const saved = localStorage.getItem(VIEW_STORAGE_KEY);
            if (saved === 'grid' || saved === 'list') setView(saved);
        } catch {
            // Private browsing or a blocked store — the default is fine
        }
    }, []);

    const chooseView = (next) => {
        setView(next);
        try {
            localStorage.setItem(VIEW_STORAGE_KEY, next);
        } catch {
            // Not worth surfacing: the layout still changes, it just won't persist
        }
    };

    // Filter items by category and search
    const filteredItems = useMemo(() => {
        let items = activeCategory === 'all'
            ? menuData.items
            : menuData.items.filter(item => item.category_id === activeCategory);

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            items = items.filter(item =>
                item.name.toLowerCase().includes(query) ||
                item.description?.toLowerCase().includes(query)
            );
        }

        return items;
    }, [menuData.items, activeCategory, searchQuery]);

    // Get category name
    const getCategoryName = (categoryId) => {
        const category = menuData.categories.find(c => c.id === categoryId);
        return category?.name || 'Other';
    };

    if (isLoading) {
        return (
            <div className={styles.loadingContainer}>
                <div className={styles.loadingSpinner}></div>
                <p>Loading menu...</p>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            {/* Header */}
            <header className={styles.header}>
                <div className={styles.headerContent}>
                    <div className={styles.branding}>
                        {/* Two assets, swapped in CSS: the source SVG's wordmark is
                            white and vanishes on the light header, so light gets the
                            dark-ink variant. Same pattern as the sidebar. */}
                        <Image
                            src={brand.logoLight}
                            alt={brand.name}
                            width={180}
                            height={54}
                            priority
                            className={`${styles.logo} ${styles.logoOnDark}`}
                        />
                        <Image
                            src={brand.logoDark}
                            alt=""
                            aria-hidden="true"
                            width={180}
                            height={54}
                            className={`${styles.logo} ${styles.logoOnLight}`}
                        />
                        <p className={styles.tagline}>Authentic Pakistani Cuisine</p>
                    </div>
                    <div className={styles.searchBar}>
                        <Search size={20} />
                        <input
                            type="text"
                            placeholder="Search our menu..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className={styles.searchInput}
                        />
                    </div>
                </div>
            </header>

            {/* Categories */}
            <div className={styles.categoriesWrapper}>
                <div className={styles.categories}>
                    <button
                        className={`${styles.categoryTab} ${activeCategory === 'all' ? styles.active : ''}`}
                        onClick={() => setActiveCategory('all')}
                    >
                        <Utensils size={18} />
                        All Items
                    </button>
                    {menuData.categories.map(category => (
                        <button
                            key={category.id}
                            className={`${styles.categoryTab} ${activeCategory === category.id ? styles.active : ''}`}
                            onClick={() => setActiveCategory(category.id)}
                        >
                            <CategoryIcon name={category.icon} size={18} />
                            {category.name}
                        </button>
                    ))}
                </div>
            </div>

            {/* Menu Content */}
            <main className={styles.mainContent}>
                {filteredItems.length > 0 && (
                    <div className={styles.toolbar}>
                        <span className={styles.resultCount}>
                            {filteredItems.length} {filteredItems.length === 1 ? 'dish' : 'dishes'}
                        </span>
                        {/* aria-label on each button because the word beside the icon
                            is hidden below 640px — without it the control reaches a
                            screen reader unnamed on exactly the devices most guests use */}
                        <div className={styles.viewToggle} role="group" aria-label="Menu layout">
                            <button
                                type="button"
                                className={`${styles.viewButton} ${view === 'grid' ? styles.viewActive : ''}`}
                                onClick={() => chooseView('grid')}
                                aria-pressed={view === 'grid'}
                                aria-label="Grid view"
                                title="Grid view"
                            >
                                <LayoutGrid size={16} />
                                <span className={styles.viewLabel}>Grid</span>
                            </button>
                            <button
                                type="button"
                                className={`${styles.viewButton} ${view === 'list' ? styles.viewActive : ''}`}
                                onClick={() => chooseView('list')}
                                aria-pressed={view === 'list'}
                                aria-label="List view"
                                title="List view"
                            >
                                <List size={16} />
                                <span className={styles.viewLabel}>List</span>
                            </button>
                        </div>
                    </div>
                )}

                {filteredItems.length === 0 ? (
                    <div className={styles.emptyState}>
                        <Utensils size={64} />
                        <h3>No items found</h3>
                        <p>Try a different search term or category</p>
                    </div>
                ) : (
                    <div className={view === 'list' ? styles.menuList : styles.menuGrid}>
                        {filteredItems.map(item => (
                            <article
                                key={item.id}
                                className={`${styles.menuItem} ${item.is_available === false ? styles.soldOut : ''}`}
                            >
                                <div className={styles.imageContainer}>
                                    {item.image ? (
                                        <img src={item.image} alt={item.name} loading="lazy" decoding="async" />
                                    ) : (
                                        <div className={styles.noImage}>
                                            <Utensils size={40} />
                                        </div>
                                    )}
                                    <span className={styles.categoryBadge}>
                                        {getCategoryName(item.category_id)}
                                    </span>
                                    {/* Told outright rather than removed from the menu: a guest
                                        who asks for it should hear it before ordering, and a
                                        dish that silently disappears looks like it never existed. */}
                                    {item.is_available === false && (
                                        <span className={styles.soldOutTag}>Sold out</span>
                                    )}
                                </div>
                                <div className={styles.itemContent}>
                                    {/* Name and description travel together so the list
                                        layout can set them beside the price rather than
                                        above it, without either one wrapping oddly. */}
                                    <div className={styles.itemText}>
                                        <div className={styles.itemHeader}>
                                            <h3>{item.name}</h3>
                                            {item.unit && (
                                                <span className={styles.unitBadge}>{item.unit}</span>
                                            )}
                                        </div>
                                        {item.description && (
                                            <p className={styles.itemDesc}>{item.description}</p>
                                        )}
                                    </div>
                                    <div className={styles.itemFooter}>
                                        <div className={styles.priceSection}>
                                            <span className={styles.price}>
                                                Rs. {money(item.price)}
                                            </span>
                                            {item.variants && item.variants.length > 0 && (
                                                <div className={styles.variants}>
                                                    {item.variants.map((v, idx) => (
                                                        <span key={idx} className={styles.variant}>
                                                            {v.name}: Rs. {money(v.price)}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
            </main>

            {/* Footer */}
            <footer className={styles.footer}>
                <p>&copy; {new Date().getFullYear()} {brand.name}. All rights reserved.</p>
                <p className={styles.footerNote}>Prices are subject to applicable taxes</p>
            </footer>
        </div>
    );
}
