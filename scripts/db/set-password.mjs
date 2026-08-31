/*
 * Sets one person's password from the terminal — the break-glass path when an
 * admin has locked themselves out and nobody left can reach the Users screen.
 * The in-app paths (Profile for yourself, Users for anyone) are the normal way.
 *
 *   node scripts/db/set-password.mjs adnan
 *   node scripts/db/set-password.mjs adnan@example.com
 *
 * The argument matches a username OR an email, exactly as the sign-in box
 * does. The new password is always flagged must_change_password: whoever ran
 * this now knows it, so the account's owner has to replace it. token_version
 * is bumped too, so any device still holding that account's cookie is signed
 * out at its next action.
 *
 * Env (from .env.local / .env.production or the shell):
 *   DB_NAME (required), DB_USER, DB_PASSWORD, DB_HOST/DB_PORT or DB_SOCKET.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    console.error('DB_NAME is not set — refusing to guess which database to touch.');
    process.exit(1);
}

const MIN_PASSWORD = 8;

/*
 * One readline interface for the whole run, opened on the first question. A
 * second interface over the same stdin inherits none of what the first had
 * already buffered, which turns piped answers into a hang.
 */
let rl = null;

const closeInput = () => {
    rl?.close();
    rl = null;
};

const die = (message) => {
    closeInput();
    console.error(message);
    process.exit(1);
};

const identifier = (process.argv[2] || '').trim();
if (!identifier) die('Usage: node scripts/db/set-password.mjs <username-or-email>');

const ask = (label) => new Promise((resolve) => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(label);
    // The question is written directly above, so readline can be struck mute
    // for the answer without the prompt disappearing with it.
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
        process.stdout.write('\n');
        resolve(answer.trim());
    });
});

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

// Look the account up before asking for anything: typing a password twice only
// to be told the username was a typo is a bad minute to have in a crisis.
const [matches] = await conn.query(
    'SELECT id, username, email, role, is_active FROM users WHERE username = ? OR email = ?',
    [identifier, identifier],
);

if (matches.length === 0) {
    await bail(`No account matches '${identifier}' on ${DB_NAME}. `
        + 'Run scripts/db/seed-users.mjs to mint an admin from scratch.');
}
// Only reachable if a username and somebody else's email are the same string;
// refusing beats guessing which of the two to reset.
if (matches.length > 1) {
    await bail(`'${identifier}' matches ${matches.length} accounts (${matches.map((u) => u.username).join(', ')}) — pass the exact username.`);
}

const user = matches[0];

const password = await ask(`New password for ${user.username} [${user.role}] (min ${MIN_PASSWORD} chars): `);
if (password.length < MIN_PASSWORD) {
    await bail(`Refused: the password must be at least ${MIN_PASSWORD} characters.`);
}
if (await ask('Type it again: ') !== password) {
    await bail('The two entries did not match. Nothing was changed.');
}
closeInput();

const hash = await bcrypt.hash(password, 12);

await conn.query(
    `UPDATE users
        SET password_hash = ?, must_change_password = 1,
            token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`,
    [hash, user.id],
);

await conn.query(
    `INSERT INTO audit_log (branch_id, business_date, action, staff_id, details)
     VALUES (1, CURRENT_DATE, 'reset_password', ?, ?)`,
    [user.id, JSON.stringify({ username: user.username, role: user.role, source: 'cli' })],
);

console.log(`password set for '${user.username}' on ${DB_NAME} — must be changed at next sign-in, `
    + 'token_version bumped (signed-in devices must sign in again)');
if (!user.is_active) {
    console.log('  NOTE: this account is disabled, so the new password will not get anyone in. '
        + 'Re-enable it from the Users screen, or seed a fresh admin.');
}

await conn.end();
