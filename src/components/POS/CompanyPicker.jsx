'use client';
import { useState, useEffect, useMemo } from 'react';
import styles from './CompanyPicker.module.css';
import { listCompaniesForPicker } from '@/app/companies/actions';
import { Building2, Search, Loader2 } from 'lucide-react';

/*
 * The payment sheet opens this when the operator picks City Ledger: a short,
 * searchable list of the accounts a bill may be charged to. Selection is the
 * only output — the till does the settling, this modal never touches an
 * order. Mounted-means-open, like ModifierModal: the parent renders it only
 * while choosing, so there is no `open` prop to fall out of sync.
 */
const CompanyPicker = ({ onSelect, onClose }) => {
    // null while loading — an empty array must mean "there really are none",
    // because those two states get different words below.
    const [companies, setCompanies] = useState(null);
    const [error, setError] = useState('');
    const [term, setTerm] = useState('');

    useEffect(() => {
        let cancelled = false;
        listCompaniesForPicker().then((res) => {
            if (cancelled) return;
            if (res.error) setError(res.error);
            else setCompanies(res.data);
        });
        return () => { cancelled = true; };
    }, []);

    const filtered = useMemo(() => {
        if (!companies) return [];
        const q = term.trim().toLowerCase();
        if (!q) return companies;
        return companies.filter((c) =>
            c.name.toLowerCase().includes(q)
            || (c.contact || '').toLowerCase().includes(q));
    }, [companies, term]);

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div className={styles.header}>
                    <h2>Charge to company</h2>
                    <button type="button" onClick={onClose} className={styles.closeBtn} aria-label="Close">
                        ×
                    </button>
                </div>

                <div className={styles.searchBox}>
                    <Search size={15} className={styles.searchIcon} aria-hidden="true" />
                    <input
                        type="search"
                        className={styles.searchInput}
                        placeholder="Search company or contact"
                        value={term}
                        onChange={(e) => setTerm(e.target.value)}
                        aria-label="Search companies"
                        autoFocus
                    />
                </div>

                <div className={styles.list}>
                    {error ? (
                        <p className={styles.stateText}>{error}</p>
                    ) : companies === null ? (
                        <p className={styles.stateText}>
                            <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                            Loading companies…
                        </p>
                    ) : filtered.length === 0 ? (
                        <p className={styles.stateText}>
                            {companies.length === 0
                                ? 'No active companies — an admin sets them up under Companies.'
                                : 'No company matches that search.'}
                        </p>
                    ) : (
                        filtered.map((company) => (
                            <button
                                key={company.id}
                                type="button"
                                className={styles.row}
                                onClick={() => onSelect(company)}
                            >
                                <Building2 size={18} className={styles.rowIcon} aria-hidden="true" />
                                <span className={styles.rowText}>
                                    <span className={styles.rowName}>{company.name}</span>
                                    {company.contact && (
                                        <span className={styles.rowContact}>{company.contact}</span>
                                    )}
                                </span>
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};

export default CompanyPicker;
