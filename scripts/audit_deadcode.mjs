/*
 * Mechanical half of the codebase cleanup audit.
 *
 * Finds what can be found by reading imports and exports: files nothing
 * references, exports nothing imports, dependencies nothing uses, and assets
 * nothing serves. It deliberately does NOT judge — a name appearing here is a
 * candidate for a human to weigh, not a deletion order. The judgment half
 * (duplicate logic, over-complexity, legacy) lives in the /cleanup-audit
 * skill, which runs this first and then reads the code.
 *
 *   node scripts/audit_deadcode.mjs          # human-readable
 *   node scripts/audit_deadcode.mjs --json   # machine-readable
 *
 * Framework entry points are excluded by convention rather than by import:
 * Next.js discovers page/layout/loading/route/middleware by filename, so they
 * are reachable even though nothing imports them.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src');

// `proxy` is Next 16's rename of `middleware` — framework-discovered by
// filename, so nothing imports it and it is not an orphan.
const NEXT_ENTRY = /^(page|layout|loading|error|not-found|route|template|default|middleware|proxy|icon|opengraph-image)\.(js|jsx|ts|tsx)$/;
const CODE = /\.(js|jsx|mjs|ts|tsx)$/;

const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
};

const files = walk(SRC);
const codeFiles = files.filter(f => CODE.test(f));
const cssFiles = files.filter(f => f.endsWith('.css'));

const read = f => readFileSync(f, 'utf8');
const rel = f => relative(ROOT, f);

// ---------------------------------------------------------------- imports --

/* Resolves an import specifier to a file on disk, or null for a package. */
const resolveImport = (spec, fromFile) => {
    let base;
    if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
    else return null; // bare package

    // .mjs is a first-class src extension here (shared server/Node modules);
    // leaving it out once made mysql2 look script-only and pool.mjs orphaned.
    for (const cand of [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`,
                        join(base, 'index.js'), join(base, 'index.jsx')]) {
        if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
    return null;
};

const importsOf = (src) => {
    const specs = [];
    const patterns = [
        /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,   // import x from 'y'
        /import\s*['"]([^'"]+)['"]/g,                  // import 'y'
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // dynamic import('y')
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // require('y')
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(src))) specs.push(m[1]);
    }
    return specs;
};

// Named + default exports declared in a file.
const exportsOf = (src) => {
    const names = new Set();
    const patterns = [
        /export\s+(?:const|let|var|function|async\s+function|class)\s+([A-Za-z0-9_$]+)/g,
        /export\s*\{([^}]+)\}/g,
    ];
    let m;
    while ((m = patterns[0].exec(src))) names.add(m[1]);
    while ((m = patterns[1].exec(src))) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name) names.add(name);
        }
    }
    if (/export\s+default/.test(src)) names.add('default');
    return names;
};

const graph = new Map();      // file -> Set(files it imports)
const importedBy = new Map(); // file -> Set(files importing it)
const packagesUsed = new Set();

/*
 * Standalone scripts and the test suite import from src/ too. Counting them
 * as consumers matters: without scripts/, the audit reports PLACEHOLDER_GUID
 * as dead while scripts/test_qr.mjs imports it; without tests/, it reported
 * ROUTE_PERMISSIONS as dead and un-exporting it broke the permissions suite.
 * A test IS a consumer — an export it covers is not unused.
 */
const extraConsumerDirs = ['scripts', 'tests', join('supabase', 'scripts')]
    .map(d => join(ROOT, d))
    .filter(existsSync);
const extraConsumers = extraConsumerDirs
    .flatMap(d => walk(d))
    .filter(f => CODE.test(f) || f.endsWith('.mjs'));

for (const f of [...codeFiles, ...extraConsumers]) {
    const src = read(f);
    const targets = new Set();
    for (const spec of importsOf(src)) {
        const resolved = resolveImport(spec, f);
        if (resolved) {
            targets.add(resolved);
            if (!importedBy.has(resolved)) importedBy.set(resolved, new Set());
            importedBy.get(resolved).add(f);
        } else {
            // Normalise scoped and sub-path specifiers to the package name.
            const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
            if (!pkg.startsWith('node:')) packagesUsed.add(pkg);
        }
    }
    graph.set(f, targets);
}

// ------------------------------------------------------- orphaned modules --

const isEntry = f => NEXT_ENTRY.test(f.split('/').pop());

const orphanFiles = codeFiles
    .filter(f => !isEntry(f))
    .filter(f => !(importedBy.get(f)?.size))
    .map(rel);

// --------------------------------------------------------- unused exports --

const unusedExports = [];
for (const f of codeFiles) {
    if (isEntry(f)) continue;                 // entry files export for the framework
    const declared = exportsOf(read(f));
    if (!declared.size) continue;
    const consumers = [...(importedBy.get(f) || [])];
    if (!consumers.length) continue;           // already reported as an orphan
    const consumerSrc = consumers.map(read).join('\n');
    for (const name of declared) {
        if (name === 'default') continue;
        // Word-boundary match across every file that imports this module.
        if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(consumerSrc)) {
            unusedExports.push({ file: rel(f), export: name });
        }
    }
}

// ---------------------------------------------------- unused dependencies --

const pkg = JSON.parse(read(join(ROOT, 'package.json')));
const declaredDeps = Object.keys(pkg.dependencies || {});
const declaredDev = Object.keys(pkg.devDependencies || {});

// Config files import build-time packages that src/ never mentions.
const configSrc = ['next.config.mjs', 'postcss.config.js', 'tailwind.config.js', 'eslint.config.mjs']
    .filter(f => existsSync(join(ROOT, f)))
    .map(f => read(join(ROOT, f))).join('\n');

const scriptFiles = existsSync(join(ROOT, 'scripts'))
    ? walk(join(ROOT, 'scripts')).filter(f => CODE.test(f) || f.endsWith('.mjs'))
    : [];
for (const f of scriptFiles) {
    for (const spec of importsOf(read(f))) {
        if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('node:')) {
            packagesUsed.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
        }
    }
}

/*
 * A package can be required without ever being imported: @supabase/ssr declares
 * @supabase/supabase-js as a peer, so it must stay installed even though no
 * file imports it by name. Collect every installed package's peers and treat
 * them as used.
 */
const peerRequired = new Set();
for (const dep of [...declaredDeps, ...declaredDev]) {
    const meta = join(ROOT, 'node_modules', dep, 'package.json');
    if (!existsSync(meta)) continue;
    try {
        for (const peer of Object.keys(JSON.parse(read(meta)).peerDependencies || {})) {
            peerRequired.add(peer);
        }
    } catch { /* an unreadable manifest is not evidence of anything */ }
}

const isUsed = d => packagesUsed.has(d) || configSrc.includes(d) || peerRequired.has(d);
const unusedDeps = declaredDeps.filter(d => !isUsed(d));
const unusedDevDeps = declaredDev.filter(d => !isUsed(d));

// Runtime deps that only standalone scripts use are shipping to production for
// nothing — worth flagging separately from genuinely unused ones.
const scriptOnlySrc = extraConsumers.map(read).join('\n');
const srcOnly = codeFiles.map(read).join('\n');
const devOnlyDeps = declaredDeps.filter(d =>
    !peerRequired.has(d) && !configSrc.includes(d) &&
    !srcOnly.includes(d) && scriptOnlySrc.includes(d));

// --------------------------------------------------------- unused CSS mods --

const unusedCssModules = cssFiles
    .filter(f => f.endsWith('.module.css'))
    .filter(f => !(importedBy.get(f)?.size))
    .filter(f => {
        // CSS modules are imported by path string; check textually too.
        const name = f.split('/').pop();
        return !codeFiles.some(c => read(c).includes(name));
    })
    .map(rel);

// ------------------------------------------------------------ public/ refs --

const publicDir = join(ROOT, 'public');
const allSrc = [...codeFiles, ...cssFiles].map(read).join('\n');
const unusedPublic = existsSync(publicDir)
    ? walk(publicDir)
        .map(f => relative(publicDir, f))
        .filter(f => !f.startsWith('.'))
        // sw.js and the manifest are referenced by the browser, not the bundle
        .filter(f => !['sw.js', 'manifest.webmanifest', 'offline.html'].includes(f))
        .filter(f => !allSrc.includes(f) && !allSrc.includes(f.split('/').pop()))
    : [];

// ------------------------------------------------------------------ output --

const report = {
    generated: new Date().toISOString(),
    totals: { codeFiles: codeFiles.length, cssFiles: cssFiles.length },
    orphanFiles,
    unusedExports,
    unusedDeps,
    unusedDevDeps,
    devOnlyDeps,
    unusedCssModules,
    unusedPublic,
};

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
} else {
    const section = (title, rows, fmt = String) => {
        console.log(`\n${title}  (${rows.length})`);
        if (!rows.length) console.log('  — none');
        else rows.forEach(r => console.log('  ' + fmt(r)));
    };
    console.log(`Cleanup audit · ${codeFiles.length} code files, ${cssFiles.length} stylesheets`);
    section('Files nothing imports', orphanFiles);
    section('Exports nothing imports', unusedExports, r => `${r.file}  →  ${r.export}`);
    section('Dependencies nothing imports', unusedDeps);
    section('Dev dependencies nothing imports', unusedDevDeps);
    section('Runtime deps only scripts use (candidates for devDependencies)', devOnlyDeps);
    section('CSS modules nothing imports', unusedCssModules);
    section('public/ files nothing references', unusedPublic);
    console.log('\nCandidates, not verdicts — confirm each before deleting.');
}
