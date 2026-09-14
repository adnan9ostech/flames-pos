'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import {
    subscribeConnection, getConnectionSnapshot, getConnectionServerSnapshot,
    startConnectionWatch, isDegraded,
} from '@/lib/connection';
import styles from './ConnectionStatus.module.css';

/*
 * Says out loud when this terminal isn't really connected.
 *
 * Silence is the failure mode worth designing against here: a kitchen display
 * whose socket died looks exactly like a kitchen with no orders. Staff will
 * work around a visible warning; they can't work around a screen that lies.
 *
 * Deliberately shows nothing at all when healthy — a permanent "connected"
 * badge trains people to ignore the spot where the warning appears.
 */
export default function ConnectionStatus() {
    useEffect(() => startConnectionWatch(), []);

    const snapshot = useSyncExternalStore(
        subscribeConnection,
        getConnectionSnapshot,
        getConnectionServerSnapshot,
    );

    if (!isDegraded(snapshot)) return null;

    const offline = !snapshot.online;

    return (
        <div className={`${styles.banner} ${offline ? styles.offline : styles.reconnecting}`} role="status" aria-live="polite">
            {offline ? <WifiOff size={15} aria-hidden="true" /> : <RefreshCw size={15} className={styles.spin} aria-hidden="true" />}
            <span>
                {offline
                    ? 'No connection: orders can’t be sent or updated'
                    : 'Reconnecting: this screen may be out of date'}
            </span>
        </div>
    );
}
