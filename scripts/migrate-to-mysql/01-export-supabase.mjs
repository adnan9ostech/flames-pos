/*
 * Step 1 of the Supabase -> MySQL cutover: export the six menu tables to
 * scripts/migrate-to-mysql/out/*.json.
 *
 *   node scripts/migrate-to-mysql/01-export-supabase.mjs
 *
 * Signs in as the admin (email/password auth, the PIN is the password)
 * because RLS only shows store_settings and branches to authenticated users —
 * an anonymous export would silently produce empty files for both, and 04
 * would then load a database with no tax rates.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 * AUTH_ADMIN_EMAIL, and ADMIN_PIN (prompted, hidden, when unset).
 */
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { outPath, writeJson } from './_lib.mjs';

const TABLES = ['branches', 'categories', 'menu_items', 'modifiers', 'waiters', 'store_settings'];

const promptHidden = (label) => new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
        reject(new Error('ADMIN_PIN is not set and stdin is not a TTY — export ADMIN_PIN and re-run.'));
        return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(label);
    rl._writeToOutput = () => {}; // a PIN typed at a till must never echo
    rl.question('', (answer) => {
        rl.close();
        process.stdout.write('\n');
        resolve(answer.trim());
    });
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const email = process.env.AUTH_ADMIN_EMAIL;
if (!url || !anonKey || !email) {
    console.error('Missing env: need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and AUTH_ADMIN_EMAIL.');
    process.exit(1);
}

const pin = process.env.ADMIN_PIN || await promptHidden(`Admin PIN for ${email}: `);
if (!pin) {
    console.error('No PIN given — aborting.');
    process.exit(1);
}

const supabase = createClient(url, anonKey, { auth: { persistSession: false } });

const { error: authError } = await supabase.auth.signInWithPassword({ email, password: pin });
if (authError) {
    console.error(`Sign-in failed for ${email}: ${authError.message}`);
    process.exit(1);
}

let failed = false;
for (const table of TABLES) {
    // Ordered by id so a re-run diffs cleanly against the previous export.
    const { data, error } = await supabase.from(table).select('*').order('id');
    if (error) {
        console.error(`${table}: ${error.message}`);
        failed = true;
        continue;
    }
    const file = outPath(`${table}.json`);
    writeJson(file, data);
    console.log(`${table}: ${data.length} row(s) -> ${file}`);
}

await supabase.auth.signOut();

if (failed) {
    console.error('\nExport INCOMPLETE — fix the failures above and re-run.');
    process.exit(1);
}
console.log(`\nExported ${TABLES.length} tables to ${outPath('')}`);
