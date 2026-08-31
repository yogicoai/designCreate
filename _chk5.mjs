import fs from 'node:fs';
import { MongoClient } from 'mongodb';
const Y='C:/Users/Yogibo Design/Desktop/youtube';
const env=Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const c=new MongoClient(env.MONGODB_URI,{serverSelectionTimeoutMS:15000}); await c.connect(); const db=c.db('imgcreate');
const pi=await db.collection('product_items').find({}).toArray();
const chips=await db.collection('color_chips').find({}).toArray();
const prods=await db.collection('products').find({}).toArray();
// element ids anywhere
const eidsPI=pi.flatMap(p=>(p.colors||[]).map(c=>c.elementId).filter(Boolean));
const eidsP=prods.flatMap(p=>p.colors.map(c=>c.elementId).filter(Boolean));
console.log('elementIds product_items:',eidsPI.length, eidsPI);
console.log('elementIds products:',eidsP.length);
// SIZE_CHART keys vs product_items names
const src=fs.readFileSync(Y+'/src/lib/sizeChart.js','utf8');
const keys=[...src.matchAll(/\{\s*key:\s*'([^']+)'/g)].map(m=>m[1]);
console.log('SIZE_CHART keys',keys.length);
const names=pi.map(p=>p.name.replace(/\s/g,''));
const noItem=keys.filter(k=>!names.some(n=>n.includes(k.replace(/\s/g,''))));
console.log('SIZE_CHART keys with NO product_item:',noItem);
// chips vs product color names
const chipNames=new Set(chips.map(c=>c.name));
const prodColors=[...new Set(prods.flatMap(p=>p.colors.map(c=>c.name)))];
console.log('product color names not in color_chips:',prodColors.filter(n=>!chipNames.has(n)));
// hex mismatch between chips and product slots
const chipByName=Object.fromEntries(chips.map(c=>[c.name,c.hex.toUpperCase()]));
const mism=[];
for(const p of prods) for(const c of p.colors){ const h=chipByName[c.name]; if(h && c.hex && h!==c.hex.toUpperCase()) mism.push(`${p.line}/${c.name} slot=${c.hex} chip=${h}`);}
console.log('hex mismatches slot vs chip:',mism.length); console.log(mism.slice(0,25).join('\n'));
// usage_shots coverage
const us=await db.collection('usage_shots').find({}).toArray();
console.log('usage_shots kinds:',JSON.stringify(us.reduce((a,x)=>{a[x.kind]=(a[x.kind]||0)+1;return a;},{})));
// product_items missing geometry/notes
console.log('product_items without notes:',pi.filter(p=>!p.notes).length,'without scalePrompt:',pi.filter(p=>!p.scalePrompt).length,'without spec.w:',pi.filter(p=>!p.spec?.w).length);
await c.close();
