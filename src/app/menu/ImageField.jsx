'use client';

/*
 * The dish photo.
 *
 * The picture is shrunk and re-encoded HERE, in the browser, before a byte
 * leaves the device: the owner photographs a plate on a phone and drops in a
 * 5 MB JPEG, and the upload route caps at 3 MB. Rejecting that file would be
 * technically correct and useless. A 1200px WebP at 0.82 is roughly 150 KB,
 * looks right on a till tile and on the customer menu, and uploads over the
 * restaurant's connection in about a second.
 *
 * The canvas is also the sanitiser: what gets uploaded is pixels this browser
 * decoded and re-encoded, never the original file's bytes.
 */
import { useRef, useState } from 'react';
import styles from './menu.module.css';
import own from './imageField.module.css';
import { IMAGE_MAX_BYTES } from '@/lib/menu/rules.mjs';
import { ImagePlus, Trash2, Loader2, AlertTriangle, Camera } from 'lucide-react';

const MAX_EDGE = 1200;
const QUALITY = 0.82;

/* Bytes, for a message a person can act on ("that is 6.2 MB"). */
const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/*
 * Decode, scale to fit MAX_EDGE on the long side, re-encode as WebP. Falls
 * back to the original file if the browser hands back nothing useful — an
 * old Safari with no WebP encoder still gets to upload its JPEG, and the
 * route's own size cap catches it if it is too big.
 */
const shrink = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve({ blob: file, name: file.name }); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
            (blob) => resolve(blob && blob.type === 'image/webp' && blob.size < file.size
                ? { blob, name: 'dish.webp' }
                : { blob: file, name: file.name }),
            'image/webp',
            QUALITY,
        );
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That file is not a photo this browser can read — try a JPEG, PNG or WebP'));
    };
    img.src = url;
});

/* XHR rather than fetch, for the one thing fetch cannot report: how far
 * through the upload we are. On a phone tether that bar is the difference
 * between waiting and pressing the button again. */
const upload = (blob, name, onProgress) => new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', blob, name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/menu/images');
    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* a proxy in the way answered HTML */ }
        if (xhr.status >= 200 && xhr.status < 300 && body.url) resolve(body.url);
        else reject(new Error(body.error || `The photo could not be saved (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('The photo could not reach the server — check the connection'));
    xhr.send(form);
});

export default function ImageField({ value, onChange, disabled = false, label = 'Photo' }) {
    const inputRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    const [dragging, setDragging] = useState(false);

    const take = async (file) => {
        if (!file) return;
        setError('');
        if (!/^image\//.test(file.type)) {
            setError('That is not a photo — pick a JPEG, PNG or WebP');
            return;
        }
        setBusy(true);
        setProgress(0);
        try {
            const { blob, name } = await shrink(file);
            if (blob.size > IMAGE_MAX_BYTES) {
                throw new Error(`Even shrunk, that photo is ${mb(blob.size)} — the limit is ${mb(IMAGE_MAX_BYTES)}`);
            }
            const url = await upload(blob, name, setProgress);
            onChange(url);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
            setProgress(0);
        }
    };

    const drop = (e) => {
        e.preventDefault();
        setDragging(false);
        if (disabled || busy) return;
        take(e.dataTransfer?.files?.[0]);
    };

    return (
        <div className={styles.field}>
            {label ? <span className={styles.fieldLabel}>{label}</span> : null}
            <div
                className={`${styles.photoField} ${own.zone} ${dragging ? own.zoneOver : ''}`}
                onDragOver={(e) => { e.preventDefault(); if (!disabled && !busy) setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={drop}
            >
                {value ? (
                    <img src={value} alt="" className={styles.photoPreview} />
                ) : (
                    <div className={`${styles.photoPreview} ${styles.photoEmpty}`}>
                        <Camera size={22} aria-hidden="true" />
                        <span>No photo</span>
                    </div>
                )}

                <div className={styles.photoActions}>
                    <input
                        ref={inputRef}
                        type="file"
                        accept="image/*"
                        className={own.fileInput}
                        onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }}
                        disabled={disabled || busy}
                    />
                    <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => inputRef.current?.click()}
                        disabled={disabled || busy}
                    >
                        {busy
                            ? <><Loader2 size={15} className={styles.spinner} /> Uploading…</>
                            : <><ImagePlus size={15} /> {value ? 'Replace photo' : 'Choose photo'}</>}
                    </button>
                    {value && (
                        <button
                            type="button"
                            className={`${styles.secondaryBtn} ${styles.dangerOutline}`}
                            onClick={() => { setError(''); onChange(null); }}
                            disabled={disabled || busy}
                        >
                            <Trash2 size={15} /> Remove photo
                        </button>
                    )}
                    {busy && (
                        <div className={own.bar} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                            <div className={own.barFill} style={{ width: `${progress}%` }} />
                        </div>
                    )}
                    <span className={styles.hint}>
                        Drag a photo here, or choose one. It is shrunk to 1200px and saved as WebP
                        before uploading, so a phone photo is fine.
                    </span>
                </div>
            </div>
            {error && (
                <span className={`${styles.hint} ${own.error}`} role="alert">
                    <AlertTriangle size={12} aria-hidden="true" /> {error}
                </span>
            )}
        </div>
    );
}
