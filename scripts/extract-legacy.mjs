// [1회성 이관 도구] youtube 프로젝트의 하드코딩 상수를
// vm 으로 평가해서 JSON 자산으로 뽑아낸다. (JSX 는 잘라내고 데이터 구간만)
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = process.env.YOUTUBE_SRC || 'C:/Users/Yogibo Design/Desktop/youtube/src/app';

// 파일에서 데이터 구간만 잘라 vm 으로 평가 → 지정한 변수들을 회수
function evalConsts(file, endMarker, wanted) {
  const src = fs.readFileSync(file, 'utf8');
  const end = src.indexOf(endMarker);
  if (end < 0) throw new Error(`endMarker 못 찾음: ${endMarker} in ${file}`);
  const head = src
    .slice(0, end)
    .split('\n')
    .filter((l) => !/^\s*(import|'use client')/.test(l))
    .join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(head + '\n;globalThis.__out = {' + wanted.map((w) => `${w}: typeof ${w} !== 'undefined' ? ${w} : null`).join(',') + '};', ctx);
  return ctx.__out;
}

const thumbs = evalConsts(`${ROOT}/thumbnails/page.js`, 'const C = {', [
  'RECIPE', 'CAUTIONS', 'CANDIDATES', 'PRESS_REFS', 'SLIM_REFS', 'MIDI_REFS', 'MINI_REFS',
  'LOUNGER_REFS', 'DROP_REFS', 'PYRAMID_REFS', 'POD_REFS', 'DOUBLE_REFS', 'SUPPORT_REFS',
  'MIDI_POSEREFS', 'THUMB_MODELS', 'SPECS', 'PRODUCTS',
]);

const models = evalConsts(`${ROOT}/models/page.js`, 'const C = {', [
  'SHEETS', 'IDENTITY_FIELDS', 'CATEGORIES', 'PIPE',
]);

const out = { thumbs, models };
const dest = process.argv[2];
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');

// 요약
const cuts = [];
for (const p of thumbs.PRODUCTS || []) {
  for (const c of p.colors || []) {
    if (c.url) cuts.push({ product: p.product, color: c.name, url: c.url, spec: c.spec });
    for (const cu of c.cuts || []) cuts.push({ product: p.product, color: c.name, url: cu.url, spec: cu.spec });
  }
}
const poseRefKeys = ['PRESS_REFS','SLIM_REFS','MIDI_REFS','MINI_REFS','LOUNGER_REFS','DROP_REFS','PYRAMID_REFS','POD_REFS','DOUBLE_REFS','SUPPORT_REFS'];
const poseCount = poseRefKeys.reduce((n,k)=>n+((thumbs[k]||[]).length),0);
const modelCount = (models.CATEGORIES||[]).reduce((n,c)=>n+c.models.length,0);
console.log('제품 라인    :', (thumbs.PRODUCTS || []).length);
console.log('컬러 슬롯    :', (thumbs.PRODUCTS || []).reduce((n, p) => n + (p.colors || []).length, 0));
console.log('생성 컷      :', cuts.length);
console.log('포즈 레퍼    :', poseCount, `(${poseRefKeys.map(k=>`${k.replace('_REFS','')}:${(thumbs[k]||[]).length}`).join(' ')})`);
console.log('썸네일 모델  :', (thumbs.THUMB_MODELS || []).reduce((n, c) => n + c.items.length, 0));
console.log('전속 모델    :', modelCount);
console.log('주의사항     :', (thumbs.CAUTIONS || []).length);
console.log('→', dest);
