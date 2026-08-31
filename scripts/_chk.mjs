import fs from 'node:fs';
import { MongoClient } from 'mongodb';
const env = Object.fromEntries(
  fs.readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l))
  .map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const c = new MongoClient(env.MONGODB_URI);
await c.connect();
const db = c.db(env.MONGODB_DB||'imgcreate');
const cols = await db.listCollections().toArray();
for (const col of cols.map(x=>x.name).sort()) {
  const n = await db.collection(col).countDocuments();
  console.log(col.padEnd(24), n);
}
await c.close();
