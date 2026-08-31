/*
 * Applies mysql/migrations/*.sql in filename order, recording each in
 * schema_migrations so a re-run applies only what is new.
 *
 *   node scripts/db/migrate.mjs            # applies pending files
 *   node scripts/db/migrate.mjs --status   # lists applied vs pending
 *
 * MySQL DDL commits implicitly, so a failing file can leave itself half
 * applied — every migration file must therefore be re-runnable
 * (IF NOT EXISTS / DROP IF EXISTS), and this runner records a file only
 * after the whole file succeeds.
 *
 * Env (from .env.local / .env.production or the shell):
 *   DB_NAME (required), DB_USER, DB_PASSWORD, DB_HOST/DB_PORT or DB_SOCKET.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// .env loading without depending on dotenv's load order quirks: first file
// that defines a key wins, real environment wins over both.
for (const file of ['.env.local', '.env.production']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const {
    DB_NAME, DB_USER = 'root', DB_PASSWORD = '',
    DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET,
} = process.env;

if (!DB_NAME) {
    console.error('DB_NAME is not set — refusing to guess which database to migrate.');
    process.exit(1);
}

const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    multipleStatements: true, // migration files are whole scripts
    timezone: 'Z',
});
await conn.query("SET time_zone = '+00:00'");

const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
const [maj, min, patch] = v.split(/[.-]/).map(Number);
if (maj < 8 || (maj === 8 && min === 0 && patch < 16)) {
    console.error(`MySQL ${v} is too old — 8.0.16+ is required (CHECK constraints must be enforced).`);
    process.exit(1);
}

await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(191) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

const dir = path.join(root, 'mysql', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const [appliedRows] = await conn.query('SELECT name FROM schema_migrations');
const applied = new Set(appliedRows.map((r) => r.name));

if (process.argv.includes('--status')) {
    for (const f of files) console.log(`${applied.has(f) ? 'applied' : 'PENDING'}  ${f}`);
    await conn.end();
    process.exit(0);
}

let ran = 0;
for (const f of files) {
    if (applied.has(f)) continue;
    process.stdout.write(`applying ${f} … `);
    try {
        await conn.query(readFileSync(path.join(dir, f), 'utf8'));
        await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
        console.log('ok');
        ran += 1;
    } catch (e) {
        console.log('FAILED');
        console.error(`\n${f}: ${e.message}\n`);
        console.error('The file may be half-applied (DDL commits implicitly). ' +
            'Fix the file — it must be re-runnable — and run the migrator again.');
        await conn.end();
        process.exit(1);
    }
}

console.log(ran === 0 ? `up to date (${files.length} applied) on ${DB_NAME}` : `applied ${ran} file(s) to ${DB_NAME}`);
await conn.end();
