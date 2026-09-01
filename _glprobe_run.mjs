import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
const db = process.argv[2], file = process.argv[3];
const conn = await mysql.createConnection({ host:'127.0.0.1', port:3306, user:'root', password:'', database: db, multipleStatements:true, timezone:'Z' });
await conn.query("SET time_zone = '+00:00'");
try { await conn.query(readFileSync(file,'utf8')); console.log('OK', file); }
catch(e){ console.log('FAIL', file, '::', e.code, e.message); }
await conn.end();
