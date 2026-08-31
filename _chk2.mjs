import fs from 'node:fs';
import { MongoClient } from 'mongodb';
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const c = new MongoClient(env.MONGODB_URI, {serverSelectionTimeoutMS:15000});
await c.connect();
const db = c.db('imgcreate');
for (const n of ['products','product_items','usage_shots','size_presets','variation_options','preservation_modes','talents','pose_refs','cuts','house_rules']) {
  const d = await db.collection(n).findOne({});
  console.log('=== '+n+' ===');
  console.log(JSON.stringify(d, null, 1).slice(0, 1800));
}
await c.close();
