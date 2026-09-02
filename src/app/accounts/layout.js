import AccountsNav from './AccountsNav';

/*
 * Every Accounts screen keeps the section strip above it. A nested layout does
 * not re-mount on navigation, so moving from the ledger to a voucher is a
 * change of the panel below and nothing else — the same shape /reports uses.
 */
export default function AccountsLayout({ children }) {
    return (
        <>
            <AccountsNav />
            {children}
        </>
    );
}
