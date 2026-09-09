'use client';

/*
 * One dish, being edited. A save stays on this page — the dish is still the
 * thing being worked on, and bouncing back to a list of 125 after every
 * change is how a photo gets uploaded to the wrong dish.
 *
 * The unsaved-changes guard is two halves: the editor arms the browser's own
 * beforeunload, and this page catches the links out of it, which is the way
 * somebody actually leaves.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import styles from '../../menu.module.css';
import own from '../../dishes.module.css';
import DishEditor from '../DishEditor';
import { getDishEditorData } from '../actions';
import { formatPriceRange } from '@/lib/money';
import {
    AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Utensils, X,
} from 'lucide-react';

export default function EditDishPage() {
    const { id } = useParams();
    const router = useRouter();

    const [formData, setFormData] = useState(null);
    const [dish, setDish] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [dirty, setDirty] = useState(false);
    const [leaving, setLeaving] = useState(false);

    useEffect(() => {
        let alive = true;
        getDishEditorData(id).then((res) => {
            if (!alive) return;
            if (res.error) setMessage({ type: 'error', text: res.error });
            else {
                setFormData(res.data);
                setDish(res.data.dish);
            }
            setIsLoading(false);
        });
        return () => { alive = false; };
    }, [id]);

    useEffect(() => {
        if (message.type !== 'success') return undefined;
        const t = setTimeout(() => setMessage({ type: '', text: '' }), 6000);
        return () => clearTimeout(t);
    }, [message]);

    const saved = ({ dish: fresh, unchanged }) => {
        setDish(fresh);
        setMessage({
            type: 'success',
            text: unchanged ? 'Nothing had changed, so nothing was saved.' : `${fresh.name} saved.`,
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const back = (e) => {
        if (!dirty) return;
        e.preventDefault();
        setLeaving(true);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <Link href="/menu" className={styles.backLink} onClick={back}>
                        <ArrowLeft size={14} /> Dishes
                    </Link>
                    <div className={own.titleRow}>
                        <h1 className={styles.title}>{dish ? dish.name : 'Dish'}</h1>
                        {dish?.is_archived && <span className={`${styles.chip} ${styles.chipDanger}`}>archived</span>}
                        {dish && !dish.is_available && !dish.is_archived && (
                            <span className={`${styles.chip} ${styles.chipWarn}`}>sold out</span>
                        )}
                        {dish?.variants?.length > 0 && (
                            <span className={`${styles.chip} ${styles.chipPrimary}`}>{dish.variants.length} sizes</span>
                        )}
                    </div>
                    <p className={styles.subtitle}>
                        {dish
                            ? `${formData?.categories.find((c) => c.id === dish.category_id)?.name || 'No category'} · ${formatPriceRange(dish.price, dish.variants)}`
                            : 'One dish, as the till and the customer menu see it.'}
                    </p>
                </div>
            </div>

            {message.type && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`${styles.note} ${message.type === 'error' ? styles.noteError : styles.noteSuccess}`}
                >
                    {message.type === 'error'
                        ? <AlertTriangle size={16} aria-hidden="true" />
                        : <CheckCircle2 size={16} aria-hidden="true" />}
                    {message.text}
                </div>
            )}

            {isLoading ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <Loader2 className={styles.spinner} size={28} />
                        <p>Loading the dish…</p>
                    </div>
                </div>
            ) : !dish || !formData ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <Utensils size={28} />
                        <p>This dish could not be found.</p>
                        <Link href="/menu" className={styles.secondaryBtn}>Back to the dishes</Link>
                    </div>
                </div>
            ) : (
                <DishEditor
                    key={dish.id}
                    dish={dish}
                    formData={formData}
                    onSaved={saved}
                    onDirtyChange={setDirty}
                />
            )}

            {leaving && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="leave-title">
                    <div className={styles.modal}>
                        <h2 id="leave-title" className={styles.modalTitle}>Leave without saving?</h2>
                        <p className={styles.modalBody}>
                            {dish?.name} has changes that have not been saved. Leaving now keeps the dish exactly
                            as it was before you started.
                        </p>
                        <div className={styles.modalActions}>
                            <button type="button" className={styles.secondaryBtn} onClick={() => setLeaving(false)}>
                                <X size={15} /> Keep editing
                            </button>
                            <button
                                type="button"
                                className={`${styles.secondaryBtn} ${styles.dangerOutline}`}
                                onClick={() => router.push('/menu')}
                            >
                                Discard changes
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
