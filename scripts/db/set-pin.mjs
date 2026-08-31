/*
 * Sets one role's PIN from the terminal — the break-glass path when nobody
 * can sign in (the in-app path is Settings, admin only).
 *
 *   node scripts/db/set-pin.mjs admin
 *   node scripts/db/set-pin.mjs staff
 *
 * Bumps pin_version, so every device signed in as that role is stranded at
 * its next action and must sign in with the new PIN.
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

const role = process.argv[2];
if (role !== 'admin' && role !== 'staff') {
    console.error('Usage: node scripts/db/set-pin.mjs <admin|staff>');
    process.exit(1);
}

// PIN entry stays off the screen: the prompt is printed directly, then
// readline's echo is silenced for the answer.
const promptPin = (label) => new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(label);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
        rl.close();
        process.stdout.write('\n');
        resolve(answer.trim());
    });
});

const pin = await promptPin(`New 6-digit PIN for ${role}: `);
if (!/^\d{6}$/.test(pin)) {
    console.error('Refused: a PIN is exactly 6 digits, nothing else.');
    process.exit(1);
}

const hash = await bcrypt.hash(pin, 12);

const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    timezone: 'Z',
});
await conn.query("SET time_zone = '+00:00'");

const [result] = await conn.query(
    'UPDATE users SET pin_hash = ?, pin_version = pin_version + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE role = ?',
    [hash, role],
);

if (result.affectedRows === 0) {
    console.error(`No ${role} row in ${DB_NAME} — run scripts/db/seed-users.mjs first.`);
    await conn.end();
    process.exit(1);
}

console.log(`${role} PIN updated on ${DB_NAME} (pin_version bumped — signed-in devices must sign in again).`);
await conn.end();
