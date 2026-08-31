import fs from 'node:fs';
import { MongoClient } from 'mongodb';
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const c = new MongoClient(env.MONGODB_URI); await c.connect(); const db=c.db('imgcreate');
const chips = await db.collection('color_chips').find({}).toArray();
const byName = Object.fromEntries(chips.map(x=>[x.name, x.hex]));
const prods = await db.collection('products').find({}).toArray();
const seen = new Map();
for (const p of prods) for (const col of p.colors) {
  if (!seen.has(col.name)) seen.set(col.name, new Set());
  seen.get(col.name).add(col.hex);
}
console.log('colorName | product hex(es) | chip hex | MATCH?');
for (const [name, hexes] of seen) {
  const chip = byName[name];
  const hs=[...hexes];
  console.log(`${name.padEnd(10)} | ${hs.join(',').padEnd(20)} | ${chip||'(칩없음)'} | ${chip&&hs.every(h=>h.toUpperCase()===chip.toUpperCase())?'OK':'*** MISMATCH'}`);
}
await c.close();
