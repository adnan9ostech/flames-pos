/*
 * Step 3: snapshot the website's menu (the source of truth for names,
 * descriptions, prices and sizes) to out/sanity-dishes.json.
 *
 *   node scripts/migrate-to-mysql/03-fetch-sanity.mjs
 *
 * Env: NEXT_PUBLIC_SANITY_PROJECT_ID (+ NEXT_PUBLIC_SANITY_DATASET).
 */
import { outPath, writeJson } from './_lib.mjs';

// Dynamic import so _lib's .env loading has already run when sanityMenu.js
// reads its project id at module scope.
const { fetchSanityDishes } = await import('../../src/lib/sanityMenu.js');

let dishes;
try {
    dishes = await fetchSanityDishes();
} catch (e) {
    console.error(e.message);
    process.exit(1);
}

const sized = dishes.filter((d) => Array.isArray(d.sizes) && d.sizes.length > 0).length;
const file = outPath('sanity-dishes.json');
writeJson(file, dishes);
console.log(`${dishes.length} dish(es) (${sized} sized, ${dishes.length - sized} unsized) -> ${file}`);
