import { query } from '@/lib/db/pool.mjs';

/*
 * The probe PM2 and monitoring hit. Public by design — it exposes nothing but
 * whether the pool can reach MySQL, and a health check that needs a session
 * can't tell anyone the database is down.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        await query('SELECT 1');
        return Response.json({ status: 'healthy' });
    } catch {
        return Response.json({ status: 'unhealthy' }, { status: 503 });
    }
}
