/*
 * Creates or updates the one admin account a fresh install needs to sign in.
 * Everybody else is made from the Users screen once that admin is in.
 *
 *   node scripts/db/seed-users.mjs                       # prompts for the password
 *   SEED_ADMIN_PASSWORD=… node scripts/db/seed-users.mjs # unattended (provisioning)
 *
 * Env, all optional except the password:
 *   SEED_ADMIN_USERNAME   defaults to 'admin'
 *   SEED_ADMIN_EMAIL      optional second way to sign in
 *   SEED_ADMIN_FULL_NAME  defaults to 'Administrator'
 *   SEED_ADMIN_PASSWORD   prompted for when absent
 *
 * A password that arrived through the environment is treated as already
 * compromised — it sat in a shell history, a CI variable, or somebody's
 * clipboard — so the account is flagged must_change_password. One typed at
 * this prompt was never written down and is not.
 *
 * Re-running is a password rotation, not a no-op: token_version is bumped, so
 * every device holding that account's cookie is signed out at its next action.
 *
 * Env (from .env.local / .env.production or the shell):
 *   DB_NAME (required), DB_USER, DB_PASSWORD, DB_HOST/DB_PORT or DB_SOCKET.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

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
    console.error('DB_NAME is not set — refusing to guess which database to seed.');
    process.exit(1);
}

const MIN_PASSWORD = 8;

const die = (message) => {
    console.error(message);
    process.exit(1);
};

const ask = (label, { hidden = false } = {}) => new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(label);
    // The prompt is written directly above, so readline can be struck mute for
    // the answer without losing the question.
    if (hidden) rl._writeToOutput = () => {};
    rl.question('', (answer) => {
        rl.close();
        if (hidden) process.stdout.write('\n');
        resolve(answer.trim());
    });
});

const username = (process.env.SEED_ADMIN_USERNAME || 'admin').trim();
if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
    die('SEED_ADMIN_USERNAME must be 2–64 characters of letters, digits, dot, dash or underscore.');
}

const email = (process.env.SEED_ADMIN_EMAIL || '').trim() || null;
if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    die(`SEED_ADMIN_EMAIL does not look like an address: ${email}`);
}

const fullName = (process.env.SEED_ADMIN_FULL_NAME || '').trim() || 'Administrator';

const fromEnv = process.env.SEED_ADMIN_PASSWORD !== undefined;
let password;
if (fromEnv) {
    password = process.env.SEED_ADMIN_PASSWORD;
    if (password.length < MIN_PASSWORD) {
        die(`SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
    }
} else {
    password = await ask(`Password for ${username} (min ${MIN_PASSWORD} chars): `, { hidden: true });
    if (password.length < MIN_PASSWORD) {
        die(`Refused: the password must be at least ${MIN_PASSWORD} characters.`);
    }
    // Typed blind and, when interactive, not flagged for a change at first
    // sign-in — a typo here would lock the only admin out of a fresh install.
    const again = await ask('Type it again: ', { hidden: true });
    if (again !== password) die('The two entries did not match. Nothing was changed.');
}

const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    timezone: 'Z',
});
await conn.query("SET time_zone = '+00:00'");

// Both username and email are unique, so an ON DUPLICATE KEY insert would
// happily rewrite a *different* person's row if the email were already theirs.
// Caught here instead, where the message can say whose it is.
if (email) {
    const [clash] = await conn.query(
        'SELECT username FROM users WHERE email = ? AND (username IS NULL OR username <> ?)',
        [email, username],
    );
    if (clash.length > 0) {
        await conn.end();
        die(`${email} already belongs to '${clash[0].username ?? 'another account'}' — seed a different address.`);
    }
}

const [[existing = null]] = await conn.query(
    'SELECT id, role, is_active FROM users WHERE username = ?',
    [username],
);

const hash = await bcrypt.hash(password, 12);
const mustChange = fromEnv ? 1 : 0;

await conn.query(
    `INSERT INTO users (id, email, username, full_name, role, password_hash,
                        must_change_password, is_active, permissions)
     VALUES (?, ?, ?, ?, 'admin', ?, ?, 1, NULL) AS new_row
     ON DUPLICATE KEY UPDATE
       email = new_row.email,
       full_name = new_row.full_name,
       role = 'admin',
       password_hash = new_row.password_hash,
       must_change_password = new_row.must_change_password,
       is_active = 1,
       -- Re-seeding is the fix-it path: clear any override that had taken a
       -- right away from the account that is supposed to hold all of them.
       permissions = NULL,
       token_version = token_version + 1,
       updated_at = CURRENT_TIMESTAMP(3)`,
    [randomUUID(), email, username, fullName, hash, mustChange],
);

await conn.query(
    `INSERT INTO audit_log (branch_id, business_date, action, details)
     VALUES (1, CURRENT_DATE, 'seed_admin', ?)`,
    [JSON.stringify({
        username,
        email,
        created: existing === null,
        must_change_password: Boolean(mustChange),
        source: fromEnv ? 'env' : 'prompt',
    })],
);

if (existing === null) {
    console.log(`created admin '${username}'${email ? ` <${email}>` : ''} on ${DB_NAME}`);
} else {
    console.log(`updated '${username}' on ${DB_NAME} — password reset, role set to admin, `
        + 'token_version bumped (other devices sign out at their next action)');
    if (existing.role !== 'admin') console.log(`  role was '${existing.role}'`);
    if (!existing.is_active) console.log('  account was disabled and is now active again');
}
console.log(mustChange
    ? '  must change password at first sign-in (the password came from the environment)'
    : '  password is ready to use');

await conn.end();
