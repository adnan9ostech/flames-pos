import ReportsNav from './ReportsNav';

/*
 * Every report screen keeps the library strip above it. Nested layouts do
 * not re-mount on navigation, so moving between reports is a change of the
 * panel below and nothing else.
 */
export default function ReportsLayout({ children }) {
    return (
        <>
            <ReportsNav />
            {children}
        </>
    );
}
