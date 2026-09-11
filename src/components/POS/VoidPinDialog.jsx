'use client';
import { useState } from 'react';
import styles from './VoidPinDialog.module.css';

/*
 * A manager PIN gate in front of removing a line from the cart. Mounted means
 * open, like CompanyPicker: the till renders it only while a removal is
 * waiting, so there is no `open` prop to fall out of sync.
 *
 * It asks for two things — the manager's PIN and a reason — and never touches
 * the cart itself: it hands both to the server (`verify`), which checks the
 * PIN belongs to someone who may void and records the removal with its reason.
 * onApprove, the parent's to carry out, runs only when the server agrees.
 */
const VoidPinDialog = ({ itemName, verify, onApprove, onCancel }) => {
    const [pin, setPin] = useState('');
    const [reason, setReason] = useState('');
    const [error, setError] = useState('');
    const [checking, setChecking] = useState(false);

    const ready = pin.trim() && reason.trim();

    const submit = async (e) => {
        e.preventDefault();
        if (!ready || checking) return;
        setChecking(true);
        setError('');
        const res = await verify({ pin, reason });
        setChecking(false);
        if (res?.data) {
            onApprove();
        } else {
            setError(res?.error || 'That PIN was not accepted.');
            setPin('');
        }
    };

    return (
        <div className={styles.overlay} onClick={onCancel}>
            <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
                <div className={styles.title}>Manager PIN to remove</div>
                <div className={styles.line}>
                    Removing <strong>{itemName || 'this item'}</strong> needs a manager or admin PIN and a reason.
                </div>
                <input
                    className={styles.input}
                    type="text"
                    autoFocus
                    autoComplete="off"
                    placeholder="Reason (wrong item, customer changed mind…)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={80}
                    aria-label="Reason for removing"
                    style={{ letterSpacing: 'normal', textAlign: 'left', fontSize: '0.9rem' }}
                />
                <input
                    className={styles.input}
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="••••••"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    aria-label="Manager PIN"
                />
                {error && <div className={styles.error}>{error}</div>}
                <div className={styles.actions}>
                    <button type="button" className={styles.btn} onClick={onCancel} disabled={checking}>
                        Cancel
                    </button>
                    <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={!ready || checking}>
                        {checking ? 'Checking…' : 'Remove item'}
                    </button>
                </div>
            </form>
        </div>
    );
};

export default VoidPinDialog;
