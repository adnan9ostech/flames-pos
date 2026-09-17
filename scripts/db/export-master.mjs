/*
 * Export this install's SETUP data — the menu and everything behind it — as a
 * SQL file that loads onto a freshly migrated database.
 *
 *   node scripts/db/export-master.mjs                 # from DB_NAME
 *   DB_NAME=flames_pos_dev node scripts/db/export-master.mjs
 *   node scripts/db/export-master.mjs --out /tmp/menu.sql
 *
 * Writes mysql/master-data.sql, which is NOT committed: it is a point-in-time
 * copy of one restaurant's data, it includes customer names, and a snapshot in
 * git rots the day somebody edits a price. Generate it when you need it.
 *
 * What it carries and what it deliberately leaves behind is master-tables.mjs,
 * which is the file to read before changing anything here.
 *
 * NOT IN THIS FILE, and it will be missed if nobody says so: menu PHOTOS are
 * files under UPLOAD_DIR, not rows. The SQL carries their names; the images
 * have to be copied separately. The script prints how many it expects.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { SETUP, TRANSACTIONS, COUNTERS, SYSTEM, classificationProblems, parentsFirst } from './master-tables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const file of ['.env.local', '.env.production']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}

const {
    DB_NAME, DB_USER = 'root', DB_PASSWORD = '',
    DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET,
} = process.env;

if (!DB_NAME) {
    console.error('DB_NAME is not set — refusing to guess which database to export.');
    process.exit(1);
}

const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
});

const [tableRows] = await conn.query(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [DB_NAME],
);
const inDb = tableRows.map((r) => r.t);

/* A table nobody classified is a table whose data would vanish silently. */
const problems = classificationProblems(inDb);
if (problems.length) {
    console.error(`\nRefusing to export — the table list and ${DB_NAME} disagree:\n`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error('');
    await conn.end();
    process.exit(1);
}

const [fkRows] = await conn.query(
    `SELECT table_name AS child, referenced_table_name AS parent
       FROM information_schema.key_column_usage
      WHERE table_schema = ? AND referenced_table_name IS NOT NULL`,
    [DB_NAME],
);
const ordered = parentsFirst(SETUP, fkRows);

const counts = new Map();
let carried = 0;
for (const t of ordered) {
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    counts.set(t, n);
    carried += n;
}
/*
 * The column is `image`. An earlier draft of this asked for `image_path`, and
 * the .catch() turned "no such column" into "no photos" — the absent answer
 * read as an empty one, which is the defect this codebase keeps producing. So
 * the column is confirmed to exist and a missing one is now loud.
 */
const [imgCol] = await conn.query(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'menu_items' AND column_name = 'image'`,
    [DB_NAME],
);
if (!imgCol.length) {
    console.error("menu_items has no `image` column — this script's photo check is out of date.");
    process.exit(1);
}
/*
 * Two kinds of menu photo, and only one of them is a deploy problem. The ones
 * imported from the website live under public/menu-images/ and are committed,
 * so `git clone` already carries them. Photos uploaded later from the Menu
 * screen are written to UPLOAD_DIR, outside the git tree on purpose, and those
 * are the ones a new install would be missing.
 */
const [[{ bundled }]] = await conn.query(
    "SELECT COUNT(*) AS bundled FROM menu_items WHERE image LIKE '/menu-images/menu-v%'",
);
const [[{ uploaded }]] = await conn.query(
    "SELECT COUNT(*) AS uploaded FROM menu_items WHERE image <> '' AND image NOT LIKE '/menu-images/menu-v%'",
);
await conn.end();

/*
 * mysqldump, not hand-built INSERTs: it gets escaping, charsets and NULLs
 * right, and this is not the place to reimplement that.
 *
 *   --replace         the reference rows (units, accounts, charges…) already
 *                     exist from the migrations; this install's edited
 *                     versions must win rather than collide on the PK
 *   --complete-insert names every column, so the file still loads after a
 *                     later migration adds one
 *   --no-create-info  schema comes from migrate.mjs; a CREATE TABLE here would
 *                     fight it and lose the newer definition
 *   utf8mb4           set explicitly: this codebase has already lost two
 *                     screens to a collation nobody chose
 */
const dumpArgs = [
    ...(DB_SOCKET ? [`--socket=${DB_SOCKET}`] : [`--host=${DB_HOST}`, `--port=${DB_PORT}`]),
    `--user=${DB_USER}`,
    '--no-create-info', '--replace', '--complete-insert',
    '--single-transaction', '--skip-add-locks', '--skip-disable-keys',
    '--no-tablespaces', '--default-character-set=utf8mb4',
    DB_NAME, ...ordered,
];

let body;
try {
    // MYSQL_PWD rather than --password=, so the secret is not in `ps`.
    body = execFileSync('mysqldump', dumpArgs, {
        env: { ...process.env, MYSQL_PWD: DB_PASSWORD },
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
    });
} catch (e) {
    console.error(`\nmysqldump failed: ${e.stderr || e.message}`);
    process.exit(1);
}

const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const header = `-- Flames POS — SETUP data only, from ${DB_NAME} at ${stamp}
--
-- Load onto a database that has already been migrated:
--     node scripts/db/migrate.mjs          # schema first, always
--     mysql -u <user> -p <db> < master-data.sql
--
-- CARRIES (${ordered.length} tables, ${carried} rows): the menu, its prices and
-- sizes, recipes, ingredients, suppliers, customers, tables, waiters, charges,
-- printers, the chart of accounts and the store settings.
--
-- DOES NOT CARRY, on purpose: ${TRANSACTIONS.length} transaction tables (orders,
-- payments, journals, stock, expenses, audit log), ${COUNTERS.length} counters so the
-- first live bill is number 1, and ${SYSTEM.length} system tables — schema_migrations
-- belongs to the migrator and users to the seeder. See scripts/db/master-tables.mjs.
--
-- Menu PHOTOS are files under UPLOAD_DIR, not rows. Copy that directory too.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
`;
const footer = `
SET FOREIGN_KEY_CHECKS = 1;
-- end of SETUP data
`;

const out = path.resolve(args.out || path.join(root, 'mysql/master-data.sql'));
writeFileSync(out, header + body + footer, 'utf8');

const kb = (Buffer.byteLength(header + body + footer) / 1024).toFixed(0);
console.log(`\nWrote ${out}  (${kb} KB)\n`);
console.log(`  ${ordered.length} setup tables, ${carried} rows. The ones that matter:`);
for (const t of ['categories', 'menu_items', 'branch_menu_items', 'recipes', 'recipe_lines', 'inventory_items', 'accounts', 'customers']) {
    if (counts.has(t)) console.log(`    ${String(counts.get(t)).padStart(6)}  ${t}`);
}
console.log(`\n  Left behind: ${TRANSACTIONS.length} transaction tables, ${COUNTERS.length} counters, ${SYSTEM.length} system tables.`);

if (bundled) console.log(`\n  ${bundled} dishes use a photo from public/menu-images — committed, so a clone carries them.`);
if (uploaded) {
    const dir = path.resolve(process.env.UPLOAD_DIR || path.join(root, 'uploads'), 'menu-images');
    const have = existsSync(dir) ? readdirSync(dir).length : 0;
    console.log(`\n  ${uploaded} dishes use an UPLOADED photo. ${have} file(s) in ${dir}`);
    console.log(`  Copy that directory to the new install's UPLOAD_DIR or those photos 404.`);
}
console.log('');
