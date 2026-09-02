/*
 * A dependency-free .xlsx writer. An Excel workbook is a ZIP of XML parts,
 * so this is two small things: enough of the Office Open XML vocabulary for
 * Excel to open a sheet of numbers and text, and enough of the ZIP format
 * to wrap it. node:zlib supplies the deflate; the CRC comes from the `crc`
 * package the Raast QR work already installed.
 *
 * Why not a library: the spec (accounts-spec.md §6) weighed it. SheetJS's
 * patched builds live on its own CDN, which the cPanel `npm ci` cannot reach,
 * and a CSV renamed .xls makes Excel warn on every open. Sixty lines of
 * format is cheaper than either.
 *
 * Plain-Node importable (the test drives it directly). No `server-only`
 * pragma because there is nothing here a browser could misuse — but nothing
 * imports it from the client either; the export route streams the result.
 *
 *   workbook([sheet('Trial Balance', [['Account', 'Debit'], ['Cash', 3801]])])
 *     → Buffer, ready to send as
 *       application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *
 * Cells: a number becomes a numeric cell (Excel can sum it), a string an
 * inline string, a boolean a boolean, null/undefined/'' an empty cell. A Date
 * is written as its ISO day text rather than an Excel serial — the reports
 * hand over 'YYYY-MM-DD' strings anyway, and a serial needs a styles part
 * to display as anything but a number.
 */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from 'crc';

/*
 * 1 → A, 26 → Z, 27 → AA, 702 → ZZ, 703 → AAA. Excel columns are bijective
 * base 26 (there is no zero digit), which is why a naive
 * String.fromCharCode(65 + n) emits '[' at column 27 and Excel rejects the
 * sheet. Named twice in the spec as the one real trap in this file.
 */
export const colLetter = (n) => {
    let col = Math.trunc(Number(n));
    if (!(col >= 1)) throw new Error(`Column index must be 1 or more, got ${n}`);
    let s = '';
    while (col > 0) {
        const rem = (col - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        col = Math.trunc((col - 1) / 26);
    }
    return s;
};

/* 'B7' for column 2, row 7 — both 1-indexed. */
export const cellRef = (col, row) => `${colLetter(col)}${row}`;

const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML 1.0 and Excel refuses the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/*
 * Excel's own rules for a tab name: 31 characters, none of []:*?/\ , not
 * blank. Enforced here rather than trusted, because the name comes from a
 * report title and a title may one day carry a slash.
 */
const sheetName = (name, index) => {
    const cleaned = String(name ?? '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
    return cleaned || `Sheet${index + 1}`;
};

/* A sheet is a name and an array of rows, each row an array of cell values. */
export const sheet = (name, rows) => ({ name, rows: Array.isArray(rows) ? rows : [] });

const cellXml = (value, ref) => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') {
        // NaN/Infinity have no XML spelling Excel accepts; write them as text.
        if (!Number.isFinite(value)) return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
        return `<c r="${ref}"><v>${value}</v></c>`;
    }
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    // xml:space="preserve" keeps leading/trailing spaces a memo may carry.
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
};

const sheetXml = (rows) => {
    const body = rows.map((row, r) => {
        const cells = (Array.isArray(row) ? row : [row])
            .map((v, c) => cellXml(v, cellRef(c + 1, r + 1)))
            .join('');
        return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<sheetData>${body}</sheetData></worksheet>`;
};

/*
 * The five parts (plus one worksheet per extra sheet) Excel needs before it
 * will open the file. No styles, no shared strings, no theme — every one of
 * those is optional and each is another part that can be wrong.
 */
const parts = (sheets) => {
    const names = sheets.map((s, i) => sheetName(s.name, i));
    const files = [];

    files.push(['[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '</Types>']);

    files.push(['_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>']);

    files.push(['xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets>'
        + names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>']);

    files.push(['xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + '</Relationships>']);

    sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]));
    return files;
};

/* ---- ZIP ---- */

/* MS-DOS time and date fields, which is all ZIP knows how to stamp. */
const dosStamp = (d) => ({
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
});

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/*
 * Deflated entries, one local header each, then the central directory and
 * its end record. Excel reads the central directory, so the sizes there must
 * agree with the local headers — both are written from the same numbers.
 */
export const zip = (entries, when = new Date()) => {
    const { time, date } = dosStamp(when);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        const packed = deflateRawSync(raw);
        const crc = crc32(raw) >>> 0;

        const local = Buffer.concat([
            u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(time), u16(date),
            u32(crc), u32(packed.length), u32(raw.length), u16(nameBuf.length), u16(0),
            nameBuf, packed,
        ]);
        centrals.push(Buffer.concat([
            u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(time), u16(date),
            u32(crc), u32(packed.length), u32(raw.length), u16(nameBuf.length), u16(0), u16(0),
            u16(0), u16(0), u32(0), u32(offset),
            nameBuf,
        ]));
        locals.push(local);
        offset += local.length;
    }

    const central = Buffer.concat(centrals);
    const end = Buffer.concat([
        u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
        u32(central.length), u32(offset), u16(0),
    ]);
    return Buffer.concat([...locals, central, end]);
};

/* The whole thing: sheets in, .xlsx bytes out. */
export const workbook = (sheets, when) => {
    const list = (Array.isArray(sheets) ? sheets : [sheets]).filter(Boolean);
    if (list.length === 0) throw new Error('A workbook needs at least one sheet');
    return zip(parts(list), when);
};

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
