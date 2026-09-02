/*
 * The .xlsx writer, driven directly. No database: this file lives with the
 * MySQL suite so one glob keeps everything green, but it never opens the
 * pool. What is asserted is the shape Excel checks before it will open a
 * file — the column-letter arithmetic (the one real trap: column 27 is AA,
 * not '['), a ZIP whose local headers, central directory and end record
 * agree, and parts that inflate back to XML carrying the cell values we
 * wrote, as numbers where we gave numbers and as text where we gave text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from 'crc';
import { colLetter, cellRef, sheet, workbook, zip, XLSX_MIME } from '../../src/lib/reports/xlsx.mjs';

/*
 * A small ZIP reader: walk the central directory, then inflate each entry's
 * data from its local header. Written against the format, not against the
 * writer, so it would catch a writer that lies to itself.
 */
const readZip = (buf) => {
    // End-of-central-directory record: the last 22 bytes when there is no comment.
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end of central directory signature');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    assert.equal(cdOffset + cdSize, eocd, 'central directory must end exactly where the end record begins');

    const entries = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i += 1) {
        assert.equal(buf.readUInt32LE(p), 0x02014b50, `central header signature for entry ${i}`);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const packedSize = buf.readUInt32LE(p + 20);
        const rawSize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `local header signature for ${name}`);
        assert.equal(buf.readUInt32LE(localOffset + 14), crc, `local/central crc agree for ${name}`);
        assert.equal(buf.readUInt32LE(localOffset + 18), packedSize, `local/central packed size agree for ${name}`);
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const packed = buf.subarray(dataStart, dataStart + packedSize);
        assert.equal(method, 8, `${name} is deflated`);
        const raw = inflateRawSync(packed);
        assert.equal(raw.length, rawSize, `${name} inflates to the declared size`);
        assert.equal(crc32(raw) >>> 0, crc, `${name} inflates to the declared crc`);
        entries.set(name, raw.toString('utf8'));
    }
    return entries;
};

test('column letters are bijective base 26: 27 → AA, 702 → ZZ, 703 → AAA', () => {
    assert.equal(colLetter(1), 'A');
    assert.equal(colLetter(26), 'Z');
    assert.equal(colLetter(27), 'AA');
    assert.equal(colLetter(52), 'AZ');
    assert.equal(colLetter(53), 'BA');
    assert.equal(colLetter(702), 'ZZ');
    assert.equal(colLetter(703), 'AAA');
    assert.equal(colLetter(16384), 'XFD', "Excel's last column");
    assert.equal(cellRef(28, 3), 'AB3');
    assert.throws(() => colLetter(0), /1 or more/);
    // The naive converter's failure, spelled out: nothing this emits is
    // outside A–Z, whatever the column.
    for (let n = 1; n <= 20_000; n += 1) assert.match(colLetter(n), /^[A-Z]+$/);
});

test('a workbook is a ZIP (starts with PK) whose parts inflate back to XML carrying the cells', () => {
    const rows = [
        ['Account', 'Account #', 'Opening', 'Debit', 'Credit', 'Closing'],
        ['Cash in Drawer', '10100', 0, 3801, 0, 3801],
        ['Guest & "Ledger" <Control>', '11000', 0, 3801, 3801, 0],
        ['Total', '', 0, 7602, 7602, 0],
    ];
    const buf = workbook([sheet('Trial Balance', rows), sheet('Bad/Name:Here?*[x]', [['x', 1.5, true, null]])]);

    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
    assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const parts = readZip(buf);
    assert.deepEqual([...parts.keys()].sort(), [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
    ]);
    for (const [name, xml] of parts) {
        assert.ok(xml.startsWith('<?xml version="1.0"'), `${name} is XML`);
    }

    const s1 = parts.get('xl/worksheets/sheet1.xml');
    // Numbers are numeric cells — Excel can sum them — and land in the right coordinates.
    assert.ok(s1.includes('<c r="D2"><v>3801</v></c>'), 'numeric cell at D2');
    assert.ok(s1.includes('<c r="D4"><v>7602</v></c>'), 'numeric cell at D4');
    // Strings are inline strings, escaped.
    assert.ok(s1.includes('<c r="A2" t="inlineStr"><is><t xml:space="preserve">Cash in Drawer</t></is></c>'));
    assert.ok(s1.includes('Guest &amp; &quot;Ledger&quot; &lt;Control&gt;'), 'XML-special characters are escaped');
    assert.ok(!s1.includes('<c r="B4"'), 'an empty string writes no cell');
    assert.ok(s1.includes('<row r="4">'), 'four rows');

    const s2 = parts.get('xl/worksheets/sheet2.xml');
    assert.ok(s2.includes('<c r="B1"><v>1.5</v></c>'));
    assert.ok(s2.includes('<c r="C1" t="b"><v>1</v></c>'));
    assert.ok(!s2.includes('<c r="D1"'), 'null writes no cell');

    const wb = parts.get('xl/workbook.xml');
    assert.ok(wb.includes('name="Trial Balance"'));
    assert.ok(wb.includes('name="Bad Name Here   x"'), 'sheet names lose the characters Excel forbids');
    assert.ok(wb.includes('r:id="rId2"'));

    const types = parts.get('[Content_Types].xml');
    assert.ok(types.includes('/xl/worksheets/sheet2.xml'));
});

test('wide sheets address past column Z correctly', () => {
    const row = Array.from({ length: 30 }, (_, i) => i + 1);
    const parts = readZip(workbook([sheet('Wide', [row])]));
    const xml = parts.get('xl/worksheets/sheet1.xml');
    assert.ok(xml.includes('<c r="Z1"><v>26</v></c>'));
    assert.ok(xml.includes('<c r="AA1"><v>27</v></c>'));
    assert.ok(xml.includes('<c r="AD1"><v>30</v></c>'));
    assert.ok(!xml.includes('r="[1"'), "the naive converter's '[' never appears");
});

test('zip() round-trips arbitrary bytes and an empty workbook is refused', () => {
    const payload = Buffer.from('héllo — Rs. 1,234.50\n'.repeat(50), 'utf8');
    const parts = readZip(zip([['a/b.txt', payload], ['c.txt', 'plain']], new Date(2026, 8, 2, 10, 30, 0)));
    assert.equal(parts.get('a/b.txt'), payload.toString('utf8'));
    assert.equal(parts.get('c.txt'), 'plain');
    assert.throws(() => workbook([]), /at least one sheet/);
});
