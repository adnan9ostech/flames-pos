/*
 * Creates or updates the two shared role accounts (admin / staff).
 *
 *   SEED_ADMIN_PIN=123456 SEED_STAFF_PIN=654321 node scripts/db/seed-users.mjs
 *   node scripts/db/seed-users.mjs     # prompts for any PIN not in the env
 *
 * Updating an existing row bumps pin_version, so every device signed in as
 * that role is stranded at its next action — re-seeding is a PIN rotation,
 * not a no-op.
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

const PIN_SHAPE = /^\d{6}$/;

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

const pinFor = async (role, envName) => {
    const fromEnv = process.env[envName];
    if (fromEnv !== undefined) {
        if (!PIN_SHAPE.test(fromEnv)) {
            console.error(`${envName} must be exactly 6 digits.`);
            process.exit(1);
        }
        return fromEnv;
    }
    const typed = await promptPin(`6-digit PIN for ${role}: `);
    if (!PIN_SHAPE.test(typed)) {
        console.error(`The ${role} PIN must be exactly 6 digits.`);
        process.exit(1);
    }
    return typed;
};

const adminPin = await pinFor('admin', 'SEED_ADMIN_PIN');
const staffPin = await pinFor('staff', 'SEED_STAFF_PIN');

const conn = await mysql.createConnection({
    ...(DB_SOCKET ? { socketPath: DB_SOCKET } : { host: DB_HOST, port: Number(DB_PORT) }),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    timezone: 'Z',
});
await conn.query("SET time_zone = '+00:00'");

for (const [role, pin] of [['admin', adminPin], ['staff', staffPin]]) {
    const hash = await bcrypt.hash(pin, 12);
    const [rows] = await conn.query('SELECT id FROM users WHERE role = ?', [role]);
    if (rows.length === 0) {
        await conn.query(
            'INSERT INTO users (id, role, pin_hash) VALUES (?, ?, ?)',
            [randomUUID(), role, hash],
        );
        console.log(`created ${role} account on ${DB_NAME}`);
    } else {
        await conn.query(
            'UPDATE users SET pin_hash = ?, pin_version = pin_version + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE role = ?',
            [hash, role],
        );
        console.log(`updated ${role} PIN on ${DB_NAME} (pin_version bumped — other devices sign out at their next action)`);
    }
}

await conn.end();
