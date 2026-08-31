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
 *   SEED_ADMIN_FULL_NAME  prompted for when absent
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

/*
 * One readline interface for the whole run, with answers queued as they land.
 * Two different ways to hang are being avoided here. A second interface over
 * the same stdin inherits none of what the first had already buffered. And a
 * pipe hands over every answer in a single chunk, long before the second
 * question is asked — read them straight off `question()` and the lines
 * nobody has asked for yet are emitted into the void, leaving the next prompt
 * waiting on an input that ended a millisecond ago.
 */
let rl = null;
const answers = [];   // lines that arrived before anything asked for them
let pending = null;   // the question in flight, waiting for its line
let atEnd = false;

const openInput = () => {
    if (rl) return;
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
        if (!pending) return answers.push(line);
        const deliver = pending;
        pending = null;
        deliver(line);
    });
    // Nothing more is coming. Unblock whatever is waiting instead of hanging
    // on a closed stdin; an empty answer fails the checks below honestly.
    rl.on('close', () => {
        atEnd = true;
        if (!pending) return;
        const deliver = pending;
        pending = null;
        deliver('');
    });
};

const closeInput = () => {
    rl?.close();
    rl = null;
};

const die = (message) => {
    closeInput();
    console.error(message);
    process.exit(1);
};

const ask = (label, { hidden = false } = {}) => new Promise((resolve) => {
    openInput();
    process.stdout.write(label);
    // Muting only bites on a terminal — a pipe echoes nothing either way. The
    // question is written directly above, so readline can be struck mute for
    // the answer without the prompt disappearing with it.
    if (hidden) rl._writeToOutput = () => {};
    else delete rl._writeToOutput;
    const deliver = (line) => {
        if (hidden) process.stdout.write('\n');
        resolve(String(line ?? '').trim());
    };
    if (answers.length > 0) deliver(answers.shift());
    else if (atEnd) deliver('');
    else pending = deliver;
});

const username = (process.env.SEED_ADMIN_USERNAME || 'admin').trim();
if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
    die('SEED_ADMIN_USERNAME must be 2–64 characters of letters, digits, dot, dash or underscore.');
}

const envEmail = (process.env.SEED_ADMIN_EMAIL || '').trim() || null;
if (envEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envEmail)) {
    die(`SEED_ADMIN_EMAIL does not look like an address: ${envEmail}`);
}

const envFullName = (process.env.SEED_ADMIN_FULL_NAME || '').trim() || null;
const envPassword = process.env.SEED_ADMIN_PASSWORD;
const fromEnv = envPassword !== undefined;

// Connect before prompting: a wrong DB_NAME should fail in a second, not after
// somebody has carefully typed a password twice.
const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    timezone: 'Z',
});
await conn.query("SET time_zone = '+00:00'");

const bail = async (message) => {
    await conn.end();
    die(message);
};

const [[existing = null]] = await conn.query(
    'SELECT id, email, full_name, role, is_active FROM users WHERE username = ?',
    [username],
);

// Absent env values keep whatever the row already holds rather than blanking
// it: re-seeding to rotate a password must not quietly erase the admin's name
// or their address.
const email = envEmail ?? existing?.email ?? null;
const fullName = envFullName
    ?? (fromEnv ? null : (await ask(`Full name [${existing?.full_name || 'Administrator'}]: `)) || null)
    ?? existing?.full_name
    ?? 'Administrator';

// Both username and email are unique, so an ON DUPLICATE KEY insert would
// happily rewrite a *different* person's row when the address is already
// theirs. Caught here, where the message can name who holds it.
if (email) {
    const [clash] = await conn.query(
        'SELECT username FROM users WHERE email = ? AND (username IS NULL OR username <> ?)',
        [email, username],
    );
    if (clash.length > 0) {
        await bail(`${email} already belongs to '${clash[0].username ?? 'another account'}' — seed a different address.`);
    }
}

let password;
if (fromEnv) {
    password = envPassword;
    if (password.length < MIN_PASSWORD) {
        await bail(`SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
    }
} else {
    password = await ask(`Password for ${username} (min ${MIN_PASSWORD} chars): `, { hidden: true });
    if (password.length < MIN_PASSWORD) {
        await bail(`Refused: the password must be at least ${MIN_PASSWORD} characters.`);
    }
    // Typed blind, and an interactively-typed password is not flagged for a
    // change at first sign-in — a typo here would lock the only admin out.
    if (await ask('Type it again: ', { hidden: true }) !== password) {
        await bail('The two entries did not match. Nothing was changed.');
    }
}
closeInput();

const hash = await bcrypt.hash(password, 12);
const mustChange = fromEnv ? 1 : 0;
// An update keeps the id it already had; only a genuine insert takes the new
// one. Knowing which lets the audit row name the account it touched.
const id = existing?.id ?? randomUUID();

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
       permissions = NULL,
       token_version = token_version + 1,
       updated_at = CURRENT_TIMESTAMP(3)`,
    [id, email, username, fullName, hash, mustChange],
);

await conn.query(
    `INSERT INTO audit_log (branch_id, business_date, action, staff_id, details)
     VALUES (1, CURRENT_DATE, 'seed_admin', ?, ?)`,
    [id, JSON.stringify({
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
    console.log(`updated '${username}' on ${DB_NAME} — password reset, token_version bumped `
        + '(other devices sign out at their next action)');
    if (existing.role !== 'admin') console.log(`  role was '${existing.role}', now admin`);
    if (!existing.is_active) console.log('  account was disabled and is active again');
    console.log('  any per-user permission override was cleared — the admin role grants everything');
}
console.log(mustChange
    ? '  must change the password at first sign-in (it came from the environment)'
    : '  the password is ready to use');

await conn.end();
