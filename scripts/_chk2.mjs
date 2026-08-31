import fs from 'node:fs';
import { MongoClient } from 'mongodb';
const env = Object.fromEntries(
  fs.readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l))
  .map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const c = new MongoClient(env.MONGODB_URI); await c.connect();
const db = c.db('imgcreate');
const show = async (col, q={}, proj=null) => {
  const d = await db.collection(col).findOne(q, proj?{projection:proj}:{});
  console.log('=== '+col+' ===');
  console.log(JSON.stringify(d, null, 1).slice(0, 2600));
};
await show('products', {line:'Pod'});
await show('talents', {code:'W_B'});
await show('pose_refs');
await show('size_presets');
await show('variation_options');
await show('preservation_modes');
await show('usage_shots');
await show('product_items');
await show('house_rules');
await c.close();
