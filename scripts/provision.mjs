/*
 * Stand up one new restaurant on this box.
 *
 *   node scripts/provision.mjs --db ostech_mandi --name "Mandi House" \
 *        --colour '#1f7a4d' --admin owner --port 3021
 *
 * WHY THIS IS A COMMAND AND NOT A WEB CONSOLE, because that is the question
 * this file exists to answer:
 *
 * A console you log into to manage every customer is a single credential that
 * reaches every restaurant's takings, every restaurant's FBR registration and
 * every restaurant's bank details. One phished password, and it is not one
 * business that is exposed. There is no version of that trade worth making for
 * a handful of installs, and the isolation this product already has — one
 * database and one vhost per restaurant, see docs/deploy-cpanel.md — is
 * stronger than any WHERE clause a console could enforce.
 *
 * So provisioning runs where the databases already live, as the operator who
 * already has that access, and it CREATES an install without ever being able
 * to read one. It writes a new database, a brand, and a first admin. It has no
 * command that opens an existing restaurant's books, and it should never grow
 * one — the day this needs a "look at customer X" flag is the day it has
 * become the thing described above.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: create the Apache vhost, the PM2 entry or
 * the env file. Those are per-vhost changes on a shared box carrying 150 other
 * sites, and docs/deploy-cpanel.md is emphatic that nothing there happens
 * except by a human who has read the rule. This prints exactly what to paste
 * and stops.
 *
 * Refuses a database that already has a schema_migrations table with rows:
 * provisioning over a live restaurant is the one mistake that cannot be undone
 * from here.
 *
 * Env (from .env.local / .env.production or the shell):
 *   DB_USER, DB_PASSWORD, DB_HOST/DB_PORT or DB_SOCKET — the SERVER, not a
 *   database. --db names the database and it must not exist yet.
 *   SEED_ADMIN_PASSWORD — optional; a generated one is printed when absent.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['.env.local', '.env.production']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

/* --flag value pairs; --flag on its own is true. */
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const next = process.argv[i + 1];
    args[a.slice(2)] = !next || next.startsWith('--') ? true : (i += 1, next);
}

const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };

const dbName = args.db;
const displayName = args.name;
if (!dbName || dbName === true) die('--db is required: the database to create, e.g. ostech_mandi');
if (!displayName || displayName === true) die('--name is required: the restaurant\'s name, e.g. "Mandi House"');

// The identifier goes into a CREATE DATABASE, which cannot be parameterised.
// Whitelisted rather than escaped: a name that is not [a-z0-9_] is a mistake
// worth refusing, not a string worth quoting.
if (!/^[a-z][a-z0-9_]{2,63}$/.test(dbName)) {
    die(`--db "${dbName}" is not a plain lowercase identifier. Use letters, digits and underscores.`);
}

const colour = args.colour === true ? '' : (args.colour || '');
if (colour && !/^#[0-9a-fA-F]{6}$/.test(colour)) {
    die(`--colour "${colour}" is not a six-digit hex like #1f7a4d.`);
}

const adminUser = args.admin === true || !args.admin ? 'admin' : args.admin;
// A password that arrived through the environment has already been in a shell
// history; seed-users.mjs flags such an account must_change_password, and a
// generated one is shown once here and nowhere else.
const generated = !process.env.SEED_ADMIN_PASSWORD;
const adminPassword = process.env.SEED_ADMIN_PASSWORD || randomBytes(9).toString('base64url');

const {
    DB_USER = 'root', DB_PASSWORD = '',
    DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_SOCKET,
} = process.env;

const connection = {
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
    timezone: 'Z',
};

const server = await mysql.createConnection(connection);

const [existing] = await server.query('SHOW DATABASES LIKE ?', [dbName]);
if (existing.length) {
    // Not merely "it exists" — an empty database somebody made by hand is fine
    // to adopt. What must never happen is provisioning over a restaurant that
    // is trading.
    const [[{ n }]] = await server.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?`, [dbName],
    );
    if (n > 0) {
        await server.end();
        die(`Database "${dbName}" already has ${n} tables. Refusing to provision over an existing install.\n` +
            `If this really is a blank slate, drop it yourself first — that is not this script's call to make.`);
    }
    console.log(`database ${dbName} exists and is empty — adopting it`);
} else {
    await server.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    console.log(`created database ${dbName}`);
}
await server.end();

/*
 * Migrations run through the real migrator as a child process, not a copy of
 * its logic here. Two ways to build a schema is how the second one drifts, and
 * the one that drifts is always the one only new customers use.
 */
console.log('\napplying migrations …');
execFileSync(process.execPath, [path.join(root, 'scripts', 'db', 'migrate.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, DB_NAME: dbName },
});

const db = await mysql.createConnection({ ...connection, database: dbName });

/*
 * The brand, and the restaurant's own name on its own branch. 001_baseline
 * seeds a branch named after the restaurant this app was first written for,
 * which is correct for that install and wrong for every other one.
 */
await db.query(
    `INSERT INTO store_settings (id, merchant_name, brand_name, brand_colour)
     VALUES (?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE merchant_name = new_row.merchant_name,
                             brand_name = new_row.brand_name,
                             brand_colour = new_row.brand_colour`,
    [randomUUID(), displayName, displayName, colour],
);
await db.query('UPDATE branches SET name = ?, code = ? WHERE id = 1', [displayName, 'MAIN']);
console.log(`\nbranded as "${displayName}"${colour ? ` in ${colour}` : ' (built-in colour)'}`);
await db.end();

console.log('\nseeding the first admin …');
execFileSync(process.execPath, [path.join(root, 'scripts', 'db', 'seed-users.mjs')], {
    stdio: 'inherit',
    env: {
        ...process.env,
        DB_NAME: dbName,
        SEED_ADMIN_USERNAME: adminUser,
        SEED_ADMIN_FULL_NAME: args['admin-name'] && args['admin-name'] !== true ? args['admin-name'] : displayName,
        SEED_ADMIN_PASSWORD: adminPassword,
    },
});

const port = args.port && args.port !== true ? args.port : '30XX';

console.log(`
────────────────────────────────────────────────────────────────────────
  ${displayName} is provisioned.

  database   ${dbName}
  sign in    ${adminUser} / ${adminPassword}${generated ? '   (generated — shown once)' : ''}
             the account must change this password at first sign-in

  STILL TO DO BY HAND, and deliberately so — these are per-vhost changes
  on a box with 150 other sites (docs/deploy-cpanel.md):

  1. .env.production for this install:
         DB_NAME=${dbName}
         DB_SOCKET=/var/lib/mysql/mysql.sock
         SESSION_SECRET=${randomBytes(32).toString('hex')}
         PORT=${port}
     SESSION_SECRET is generated above and is per-install: two restaurants
     sharing one would make each other's session cookies valid.

  2. A PM2 entry on port ${port}, and the Apache userdata include that
     proxies this customer's domain to 127.0.0.1:${port}.

  3. FBR credentials, when that restaurant registers. Server env only,
     never the database, never shared with another install.

  The brand, logo and everything else is now theirs to change from
  Settings. Nothing about this install references any other one.
────────────────────────────────────────────────────────────────────────
`);
