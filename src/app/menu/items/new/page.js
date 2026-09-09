'use client';

/*
 * Add a dish. The editor does the work; this page only fetches what the form
 * draws from, and decides where a save lands — back on the list, with the
 * new dish lit up, because the next thing anybody does after adding a dish
 * is look at where it sits among the others.
 *
 * The confirmation travels in sessionStorage rather than the URL, so the
 * list needs no useSearchParams and no Suspense boundary — the same trick
 * the expense vouchers use.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from '../../menu.module.css';
import DishEditor from '../DishEditor';
import { getDishEditorData } from '../actions';
import { AlertTriangle, ArrowLeft, Loader2, X } from 'lucide-react';

export default function NewDishPage() {
    const router = useRouter();
    const [formData, setFormData] = useState(null);
    const [error, setError] = useState('');
    const [dirty, setDirty] = useState(false);
    const [leaving, setLeaving] = useState(false);

    useEffect(() => {
        let alive = true;
        getDishEditorData(null).then((res) => {
            if (!alive) return;
            if (res.error) setError(res.error);
            else setFormData(res.data);
        });
        return () => { alive = false; };
    }, []);

    const saved = ({ dish }) => {
        try {
            sessionStorage.setItem('menu-flash', `${dish.name} added to the menu.`);
            sessionStorage.setItem('menu-new', dish.id);
        } catch { /* private mode: the list still shows the dish */ }
        router.push('/menu');
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
                    <h1 className={styles.title}>Add a dish</h1>
                    <p className={styles.subtitle}>
                        Name it, put it in a category, give it a price or its sizes. It is on the till
                        the moment you save.
                    </p>
                </div>
            </div>

            {error && (
                <div className={`${styles.note} ${styles.noteError}`} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" /> {error}
                </div>
            )}

            {!formData ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        {error ? <AlertTriangle size={28} /> : <Loader2 className={styles.spinner} size={28} />}
                        <p>{error ? 'The form could not be prepared.' : 'Loading categories and sizes…'}</p>
                    </div>
                </div>
            ) : formData.categories.length === 0 ? (
                <div className={styles.listWrap}>
                    <div className={styles.stateBlock}>
                        <AlertTriangle size={28} />
                        <p>There are no categories yet, and every dish belongs to one.</p>
                        <Link href="/menu/categories" className={styles.secondaryBtn}>Add a category</Link>
                    </div>
                </div>
            ) : (
                <DishEditor formData={formData} onSaved={saved} onDirtyChange={setDirty} />
            )}

            {leaving && (
                <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="leave-title">
                    <div className={styles.modal}>
                        <h2 id="leave-title" className={styles.modalTitle}>Leave without saving?</h2>
                        <p className={styles.modalBody}>
                            This dish has not been saved, so nothing of it exists yet. Leaving now loses what
                            you have typed.
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
                                Leave anyway
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
