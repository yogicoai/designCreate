import { MongoClient } from 'mongodb'; import fs from 'node:fs';
const uri=/MONGODB_URI=(.+)/.exec(fs.readFileSync('.env.local','utf8'))[1].trim();
const c=new MongoClient(uri); await c.connect();
const ts=await c.db('imgcreate').collection('talents').find({active:true}).sort({order:1}).project({code:1,category:1,slot:1,name:1,size:1,sizeEn:1,rep:1}).toArray();
for(const t of ts) console.log(`${t.code} ${t.category}${t.slot} | size="${t.size}" | sizeEn="${(t.sizeEn||'').slice(0,70)}"`);
await c.close();
