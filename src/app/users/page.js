'use client';
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import styles from './users.module.css';
import {
    listUsers, createUser, updateUser, setPermissions, resetPassword, toggleActive, deleteUser,
} from './actions';
import { PERMISSIONS, PERMISSION_KEYS, ROLES, ROLE_DEFAULTS } from '@/lib/auth/permissions.mjs';
import {
    Plus, Check, X, Loader2, AlertTriangle, Trash2, Copy, RefreshCw, ShieldCheck,
} from 'lucide-react';

// 'staff' is the shared login from before people had accounts. An existing
// row still shows it; nobody is assigned to it again.
const ASSIGNABLE_ROLES = Object.keys(ROLES).filter((r) => r !== 'staff');

const EMPTY_FORM = { full_name: '', email: '', username: '', role: 'cashier' };

/*
 * Look-alike characters are stripped out: this password gets read aloud
 * across a counter or written on a slip before it is typed once, and an
 * l/1/I mix-up there costs a phone call.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const generatePassword = () => {
    const draws = new Uint32Array(12);
    crypto.getRandomValues(draws);
    const chars = Array.from(draws, (n) => ALPHABET[n % ALPHABET.length]);
    return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
        .map((group) => group.join(''))
        .join('-');
};

const whenSeen = (iso) => {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleString('en-PK', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
};

/* What a person types to prove they meant this account, not the one above it. */
const handle = (row) => row.username || row.email || row.full_name;

/*
 * Accounts. Every person who signs in has a row here, a role that carries a
 * sensible set of rights, and — where the role is nearly right but not quite
 * — their own overrides on top.
 */
export default function UsersPage() {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    // 'new' while the add form is open, a row id while that row is being
    // edited, null otherwise.
    const [editing, setEditing] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [password, setPassword] = useState('');
    // The generated password stays on screen until the admin closes the form:
    // it is never readable again, so it is shown plainly and once.
    const [revealed, setRevealed] = useState('');

    const [permsFor, setPermsFor] = useState(null);   // row id, or null
    const [draft, setDraft] = useState({});
    const [resetFor, setResetFor] = useState(null);   // row id, or null
    const [deleting, setDeleting] = useState(null);   // row, or null
    const [typed, setTyped] = useState('');

    const load = useCallback(async () => {
        const res = await listUsers();
        if (res.error) setError(res.error);
        else setUsers(res.data);
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const closeAll = () => {
        setEditing(null);
        setForm(EMPTY_FORM);
        setPassword('');
        setRevealed('');
        setPermsFor(null);
        setResetFor(null);
    };

    const startNew = () => {
        closeAll();
        setError('');
        setEditing('new');
    };

    const startEdit = (row) => {
        closeAll();
        setError('');
        setEditing(row.id);
        setForm({
            full_name: row.full_name || '',
            email: row.email || '',
            username: row.username || '',
            role: row.role,
        });
    };

    const submitForm = async () => {
        setBusy(true);
        setError('');
        const res = editing === 'new'
            ? await createUser({ ...form, password })
            : await updateUser({ ...form, id: editing });
        if (res.error) setError(res.error);
        else if (editing === 'new') {
            // The form closes, but the password stays up until it is dismissed.
            await load();
            const handover = revealed || password;
            closeAll();
            setRevealed(handover);
        } else {
            await load();
            closeAll();
        }
        setBusy(false);
    };

    const openPermissions = (row) => {
        closeAll();
        setError('');
        setPermsFor(row.id);
        setDraft({ ...row.permissions });
    };

    const savePermissions = async (row, overrides) => {
        setBusy(true);
        setError('');
        const res = await setPermissions({ id: row.id, overrides });
        if (res.error) setError(res.error);
        else { await load(); setPermsFor(null); }
        setBusy(false);
    };

    const submitReset = async (row) => {
        setBusy(true);
        setError('');
        const res = await resetPassword({ id: row.id, password });
        if (res.error) setError(res.error);
        else {
            await load();
            const handover = revealed || password;
            setResetFor(null);
            setPassword('');
            setRevealed(handover);
        }
        setBusy(false);
    };

    const flip = async (row) => {
        setBusy(true);
        setError('');
        const res = await toggleActive(row.id);
        if (res.error) setError(res.error);
        else await load();
        setBusy(false);
    };

    const confirmDelete = async () => {
        setBusy(true);
        const res = await deleteUser(deleting.id);
        if (res.error) setError(res.error);
        else { await load(); setDeleting(null); setTyped(''); }
        setBusy(false);
    };

    /*
     * Administrators first, in their own band. Everyone else follows. Who
     * holds the keys is the question this screen gets asked most, and it
     * should not have to be answered by reading an alphabetical list —
     * "Admin" happened to sort second here, which is exactly the accident
     * worth removing. Within each band the signed-in account leads, then
     * active accounts by name, with suspended ones last.
     */
    const groups = useMemo(() => {
        const rank = (u) => [u.is_you ? 0 : 1, u.is_active ? 0 : 1, (u.full_name || u.username || '').toLowerCase()];
        const byRank = (a, b) => {
            const [ax, ay, az] = rank(a); const [bx, by, bz] = rank(b);
            return ax - bx || ay - by || az.localeCompare(bz);
        };
        const isAdmin = (u) => u.role === 'admin';
        return [
            {
                key: 'admins',
                title: 'Administrators',
                hint: 'Full access, including who else may sign in',
                rows: users.filter(isAdmin).sort(byRank),
            },
            {
                key: 'team',
                title: 'Team',
                hint: 'Access follows their role',
                rows: users.filter((u) => !isAdmin(u)).sort(byRank),
            },
        ];
    }, [users]);

    if (loading) {
        return (
            <div className={styles.container}>
                <div className={styles.stateBlock}>
                    <Loader2 className={styles.spinner} size={32} />
                    <p>Loading accounts…</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Users</h1>
                <p className={styles.subtitle}>
                    Who can sign in, and what each of them may open. A role carries a
                    sensible set of rights; anyone who needs a little more or a little
                    less gets it on top of the role rather than a promotion.
                </p>
            </div>

            {error && (
                <div className={styles.error} role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    {error}
                </div>
            )}

            {revealed && !editing && !resetFor && (
                <HandoverNotice password={revealed} onDismiss={() => setRevealed('')} />
            )}

            <div className={styles.card}>
                <div className={styles.cardHead}>
                    <h2 className={styles.cardTitle}>
                        {users.filter((u) => u.is_active).length} active
                        {users.some((u) => !u.is_active)
                            && `, ${users.filter((u) => !u.is_active).length} suspended`}
                    </h2>
                    {editing !== 'new' && (
                        <button type="button" className={styles.addBtn} onClick={startNew}>
                            <Plus size={16} aria-hidden="true" />
                            Add user
                        </button>
                    )}
                </div>

                {editing === 'new' && (
                    <div className={styles.newBlock}>
                        <UserForm
                            form={form} setForm={setForm} isNew
                            onSave={submitForm} onCancel={closeAll} busy={busy}
                        />
                        <PasswordField
                            value={password}
                            onChange={setPassword}
                            revealed={revealed}
                            onGenerate={() => { const p = generatePassword(); setPassword(p); setRevealed(p); }}
                        />
                    </div>
                )}

                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Person</th>
                            <th>Signs in with</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th>Last login</th>
                            <th aria-label="Actions" />
                        </tr>
                    </thead>
                    <tbody>
                        {users.length === 0 && (
                            <tr><td colSpan={6} className={styles.empty}>
                                No accounts yet — add the first one.
                            </td></tr>
                        )}
                        {groups.map(({ key, title, hint, rows }) => (
                            <Fragment key={key}>
                                {rows.length > 0 && (
                                    <tr className={styles.groupRow}>
                                        <th colSpan={6} scope="colgroup" className={styles.groupHead}>
                                            {title}
                                            <span className={styles.groupHint}>{hint}</span>
                                        </th>
                                    </tr>
                                )}
                                {rows.map((row) => (
                            <UserRow
                                key={row.id}
                                row={row}
                                editing={editing}
                                form={form}
                                setForm={setForm}
                                onSave={submitForm}
                                onCancel={closeAll}
                                busy={busy}
                                onEdit={() => startEdit(row)}
                                permsOpen={permsFor === row.id}
                                draft={draft}
                                setDraft={setDraft}
                                onPermissions={() => openPermissions(row)}
                                onSavePermissions={savePermissions}
                                resetOpen={resetFor === row.id}
                                onReset={() => { closeAll(); setError(''); setResetFor(row.id); }}
                                password={password}
                                setPassword={setPassword}
                                revealed={revealed}
                                setRevealed={setRevealed}
                                onSubmitReset={() => submitReset(row)}
                                onFlip={() => flip(row)}
                                onDelete={() => { setError(''); setTyped(''); setDeleting(row); }}
                            />
                                ))}
                            </Fragment>
                        ))}
                    </tbody>
                </table>
            </div>

            {deleting && (
                <DeleteDialog
                    row={deleting}
                    typed={typed}
                    setTyped={setTyped}
                    busy={busy}
                    onCancel={() => { setDeleting(null); setTyped(''); }}
                    onSuspend={async () => { await flip(deleting); setDeleting(null); }}
                    onConfirm={confirmDelete}
                />
            )}
        </div>
    );
}

function UserRow({
    row, editing, form, setForm, onSave, onCancel, busy, onEdit,
    permsOpen, draft, setDraft, onPermissions, onSavePermissions,
    resetOpen, onReset, password, setPassword, revealed, setRevealed, onSubmitReset,
    onFlip, onDelete,
}) {
    if (editing === row.id) {
        return (
            <tr>
                <td colSpan={6}>
                    <UserForm
                        form={form} setForm={setForm} isNew={false} isSelf={row.is_you}
                        onSave={onSave} onCancel={onCancel} busy={busy}
                    />
                </td>
            </tr>
        );
    }

    return (
        <>
            <tr className={row.is_active ? '' : styles.suspended}>
                <td className={styles.name}>
                    {row.full_name || '—'}
                    {row.is_you && <span className={styles.youChip}>You</span>}
                </td>
                <td>
                    <div className={styles.stack}>
                        {row.email && <span>{row.email}</span>}
                        {row.username && <span className={styles.subtle}>{row.username}</span>}
                    </div>
                </td>
                <td><span className={styles.roleChip}>{row.role_label}</span></td>
                <td>
                    <div className={styles.stack}>
                        <span className={row.is_active ? styles.activeChip : styles.retiredChip}>
                            {row.is_active ? 'Active' : 'Suspended'}
                        </span>
                        {row.must_change_password && (
                            <span className={styles.subtle}>Password not changed yet</span>
                        )}
                    </div>
                </td>
                <td className={styles.subtle}>{whenSeen(row.last_login_at)}</td>
                <td className={styles.actions}>
                    <button type="button" className={styles.linkBtn} onClick={onEdit} disabled={busy}>
                        Edit
                    </button>
                    {/* An admin holds everything by definition, so there is
                        nothing to tune — offering the panel would only invite
                        an edit the server refuses. */}
                    {row.role === 'admin' ? (
                        <span className={styles.subtle}>Full access</span>
                    ) : (
                        <button type="button" className={styles.linkBtn} onClick={onPermissions} disabled={busy}>
                            Permissions
                        </button>
                    )}
                    {/* Resetting your own password would sign this device out
                        mid-edit; the profile screen does it properly. */}
                    {!row.is_you && (
                        <button type="button" className={styles.linkBtn} onClick={onReset} disabled={busy}>
                            Reset password
                        </button>
                    )}
                    {!row.is_you && (
                        <button type="button" className={styles.linkBtn} onClick={onFlip} disabled={busy}>
                            {row.is_active ? 'Suspend' : 'Restore'}
                        </button>
                    )}
                    {!row.is_you && (
                        <button
                            type="button"
                            className={styles.dangerLink}
                            onClick={onDelete}
                            disabled={busy}
                            aria-label={`Delete ${handle(row)}`}
                        >
                            <Trash2 size={14} aria-hidden="true" />
                        </button>
                    )}
                </td>
            </tr>

            {resetOpen && (
                <tr>
                    <td colSpan={6}>
                        <div className={styles.panel}>
                            <p className={styles.panelTitle}>
                                New password for {row.full_name || handle(row)}
                            </p>
                            <p className={styles.panelHint}>
                                They are asked to change it the first time they sign in, and
                                every device signed in as them is signed out now.
                            </p>
                            <PasswordField
                                value={password}
                                onChange={setPassword}
                                revealed={revealed}
                                onGenerate={() => { const p = generatePassword(); setPassword(p); setRevealed(p); }}
                            />
                            <div className={styles.panelActions}>
                                <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
                                    Cancel
                                </button>
                                <button type="button" className={styles.saveBtn} onClick={onSubmitReset} disabled={busy}>
                                    {busy
                                        ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                                        : <Check size={16} aria-hidden="true" />}
                                    Set password
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            )}

            {permsOpen && (
                <tr>
                    <td colSpan={6}>
                        <PermissionsPanel
                            row={row}
                            draft={draft}
                            setDraft={setDraft}
                            busy={busy}
                            onCancel={onCancel}
                            onSave={() => onSavePermissions(row, draft)}
                            onResetToRole={() => onSavePermissions(row, null)}
                        />
                    </td>
                </tr>
            )}
        </>
    );
}

/*
 * The rights this person actually has, with the role's own answer shown
 * beside each one — the useful question is never "can they open reports" but
 * "is that because they are an accountant, or because someone decided it".
 */
function PermissionsPanel({ row, draft, setDraft, busy, onCancel, onSave, onResetToRole }) {
    const defaults = ROLE_DEFAULTS[row.role] || {};
    const custom = PERMISSION_KEYS.some((key) => Boolean(draft[key]) !== Boolean(defaults[key]));

    return (
        <div className={styles.panel}>
            <div className={styles.panelHead}>
                <p className={styles.panelTitle}>
                    <ShieldCheck size={16} aria-hidden="true" />
                    What {row.full_name || handle(row)} may open
                </p>
                <span className={custom ? styles.customChip : styles.defaultChip}>
                    {custom ? 'Custom' : `Using ${row.role_label} defaults`}
                </span>
            </div>

            <div className={styles.permGrid}>
                {PERMISSION_KEYS.map((key) => (
                    <label key={key} className={styles.permItem}>
                        <input
                            type="checkbox"
                            className={styles.checkbox}
                            checked={Boolean(draft[key])}
                            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))}
                        />
                        <span>
                            {PERMISSIONS[key]}
                            <span className={styles.permDefault}>
                                {defaults[key] ? `On for ${row.role_label}` : `Off for ${row.role_label}`}
                            </span>
                        </span>
                    </label>
                ))}
            </div>

            <div className={styles.panelActions}>
                <button type="button" className={styles.linkBtn} onClick={onResetToRole} disabled={busy}>
                    <RefreshCw size={14} aria-hidden="true" />
                    Reset to {row.role_label} defaults
                </button>
                <span className={styles.spacer} />
                <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
                    Cancel
                </button>
                <button type="button" className={styles.saveBtn} onClick={onSave} disabled={busy}>
                    {busy
                        ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                        : <Check size={16} aria-hidden="true" />}
                    Save rights
                </button>
            </div>
            <p className={styles.panelHint}>
                Saving signs this person out of their other devices, so the change takes
                effect straight away rather than whenever their cookie next expires.
            </p>
        </div>
    );
}

function UserForm({ form, setForm, isNew, isSelf, onSave, onCancel, busy }) {
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
    return (
        <div className={styles.form}>
            <input
                className={styles.input}
                placeholder="Full name"
                value={form.full_name}
                onChange={set('full_name')}
                maxLength={191}
                autoFocus
            />
            <input
                className={styles.input}
                type="email"
                placeholder="Email (optional)"
                value={form.email}
                onChange={set('email')}
                maxLength={191}
            />
            <input
                className={styles.input}
                placeholder="Username (optional)"
                value={form.username}
                onChange={set('username')}
                maxLength={32}
            />
            <select
                className={styles.input}
                value={form.role}
                onChange={set('role')}
                // Changing your own role mid-session is refused by the server;
                // saying so here beats saying so after the click.
                disabled={isSelf}
                title={isSelf ? 'Ask another admin to change your own role' : undefined}
            >
                {form.role === 'staff' && (
                    <option value="staff" disabled>{ROLES.staff} — pick a role</option>
                )}
                {ASSIGNABLE_ROLES.map((role) => (
                    <option key={role} value={role}>{ROLES[role]}</option>
                ))}
            </select>
            <button type="button" className={styles.saveBtn} onClick={onSave} disabled={busy}>
                {busy
                    ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                    : <Check size={16} aria-hidden="true" />}
                {isNew ? 'Create' : 'Save'}
            </button>
            <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
                <X size={16} aria-hidden="true" />
            </button>
        </div>
    );
}

function PasswordField({ value, onChange, revealed, onGenerate }) {
    return (
        <div className={styles.passwordRow}>
            <input
                className={styles.input}
                type="text"
                placeholder="Password (at least 8 characters)"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                autoComplete="new-password"
            />
            <button type="button" className={styles.ghostBtn} onClick={onGenerate}>
                <RefreshCw size={14} aria-hidden="true" />
                Generate
            </button>
            {revealed && revealed === value && <CopyButton text={revealed} />}
            <p className={styles.passwordHint}>
                Read this out or write it down now — it cannot be shown again. They are
                asked to change it the first time they sign in.
            </p>
        </div>
    );
}

/*
 * The password after the form closes. It exists nowhere else once this is
 * dismissed, so it stays until the admin says they have it.
 */
function HandoverNotice({ password, onDismiss }) {
    return (
        <div className={styles.handover}>
            <div>
                <p className={styles.handoverLabel}>Password to hand over</p>
                <p className={styles.handoverValue}>{password}</p>
                <p className={styles.subtle}>
                    Shown once. They must change it the first time they sign in.
                </p>
            </div>
            <div className={styles.handoverActions}>
                <CopyButton text={password} />
                <button type="button" className={styles.cancelBtn} onClick={onDismiss}>
                    <X size={16} aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}

function CopyButton({ text }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // A till browser with the clipboard locked down: the password is
            // on screen either way, so this stays quiet rather than alarming.
        }
    };
    return (
        <button type="button" className={styles.ghostBtn} onClick={copy}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
        </button>
    );
}

/*
 * Deleting an account is offered but never casual: it states what survives
 * (everything this person did) against what does not (the way in), puts
 * suspending in front as the reversible answer, and asks for the login to be
 * typed so it cannot be the wrong row.
 */
function DeleteDialog({ row, typed, setTyped, busy, onCancel, onSuspend, onConfirm }) {
    const confirmWord = handle(row);
    const canDelete = !busy && typed.trim() === confirmWord;

    return (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="del-title">
            <div className={styles.dialog}>
                <h2 id="del-title" className={styles.dialogTitle}>
                    <AlertTriangle size={18} aria-hidden="true" />
                    Delete {row.full_name || confirmWord}?
                </h2>

                <p className={styles.dialogBody}>
                    Their past orders, shifts and audit entries keep their name — nothing
                    in the books moves. What goes is the account itself and the way in:
                    this email and username stop signing anyone in, and any device still
                    signed in as them is cut off.
                </p>

                <p className={styles.dialogHint}>
                    Suspending does the same job for someone who has left, and can be undone.
                </p>

                <label className={styles.confirmField}>
                    <span>Type <strong>{confirmWord}</strong> to confirm</span>
                    <input
                        className={styles.input}
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        autoFocus
                    />
                </label>

                <div className={styles.dialogActions}>
                    <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
                        Cancel
                    </button>
                    {row.is_active && (
                        <button type="button" className={styles.retireBtn} onClick={onSuspend} disabled={busy}>
                            Suspend instead
                        </button>
                    )}
                    <button type="button" className={styles.deleteBtn} onClick={onConfirm} disabled={!canDelete}>
                        {busy
                            ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                            : <Trash2 size={16} aria-hidden="true" />}
                        Delete permanently
                    </button>
                </div>
            </div>
        </div>
    );
}
