'use client';

import { useState } from 'react';
import Zoomable from '@/components/Zoomable';

/**
 * 전속 모델 카드 안의 '의상 컨셉' 블록 — 보기 + 직접 추가/수정/삭제.
 *
 * 여기서 추가한 의상은 이미지 생성 화면의 모델 카드 '의상' 줄에 그대로 뜨고,
 * 생성 시 프롬프트의 OUTFIT 줄로 들어간다. 이미지를 넣고 '생성 참조로 사용'을
 * 켠 것만 참조 이미지로도 함께 들어간다(얼굴 없는 컷만).
 */

export interface OutfitItem {
  code: string;
  desc: string;
  descEn?: string;
  imageUrl?: string;
  cropUrl?: string;
}

interface Props {
  talentCode: string;
  label: string;
  category: string;
  initial: OutfitItem[];
}

/** 자주 쓰는 조합 — 한 번 누르면 국문·영문이 같이 채워진다 (영문 직접 쓰는 수고 제거) */
const PRESETS: Record<string, { kr: string; en: string }[]> = {
  여성: [
    { kr: '화이트 티 + 데님', en: 'a white cotton tee with straight-leg denim jeans' },
    { kr: '크림 니트 + 와이드 슬랙스', en: 'a cream knit top with wide-leg trousers' },
    { kr: '베이지 셋업 라운지웨어', en: 'a beige matching lounge set (relaxed top and pants)' },
    { kr: '그레이 후디 + 조거', en: 'a grey hoodie with matching joggers' },
    { kr: '린넨 셔츠 + 쇼츠', en: 'an off-white linen shirt with tailored shorts' },
    { kr: '블랙 슬립 원피스', en: 'a simple black slip dress' },
  ],
  남성: [
    { kr: '화이트 티 + 차콜 슬랙스', en: 'a white tee with charcoal slacks' },
    { kr: '그레이 맨투맨 + 데님', en: 'a grey sweatshirt with denim jeans' },
    { kr: '네이비 후디 + 조거', en: 'a navy hoodie with matching joggers' },
    { kr: '옥스퍼드 셔츠 + 치노', en: 'a light-blue oxford shirt with beige chinos' },
    { kr: '블랙 반팔 + 카고', en: 'a black short-sleeve tee with olive cargo pants' },
  ],
  아동: [
    { kr: '스트라이프 티 + 반바지', en: 'a striped tee with cotton shorts' },
    { kr: '노란 맨투맨 + 데님', en: 'a yellow sweatshirt with denim pants' },
    { kr: '아이보리 파자마', en: 'ivory cotton pyjamas' },
    { kr: '민트 후디 + 레깅스', en: 'a mint hoodie with soft leggings' },
  ],
};

const blank = { desc: '', descEn: '', imageUrl: '', useAsRef: false };

export default function TalentOutfits({ talentCode, label, category, initial }: Props) {
  const [items, setItems] = useState<OutfitItem[]>(initial);
  const [open, setOpen] = useState(false);
  const [editCode, setEditCode] = useState('');      // '' = 신규
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const presets = PRESETS[category] ?? PRESETS['여성'];

  function startAdd() {
    setEditCode(''); setForm(blank); setErr(''); setOpen(true);
  }
  function startEdit(o: OutfitItem) {
    setEditCode(o.code);
    setForm({ desc: o.desc, descEn: o.descEn ?? '', imageUrl: o.imageUrl ?? '', useAsRef: !!o.cropUrl });
    setErr(''); setOpen(true);
  }

  async function upload(file: File) {
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', `${label} 의상 · ${form.desc || '무제'}`);
      fd.append('register', '0');   // 의상 컷은 레퍼런스 보관함까지 채우지 않는다
      const json = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
      if (!json.ok) throw new Error(json.error || '업로드 실패');
      setForm((f) => ({ ...f, imageUrl: json.url }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!form.desc.trim()) { setErr('의상 이름을 적어주세요.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/talents/outfits', {
        method: editCode ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ talentCode, ...(editCode ? { code: editCode } : {}), ...form }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '저장 실패');
      const o = json.outfit as OutfitItem;
      setItems((cur) => (editCode ? cur.map((x) => (x.code === editCode ? o : x)) : [...cur, o]));
      setOpen(false); setForm(blank); setEditCode('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(code: string) {
    if (!confirm(`${code} 의상을 지울까요? 이미 생성한 컷은 그대로 남습니다.`)) return;
    setBusy(true); setErr('');
    try {
      const json = await (await fetch('/api/talents/outfits', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ talentCode, code }),
      })).json();
      if (!json.ok) throw new Error(json.error || '삭제 실패');
      setItems((cur) => cur.filter((x) => x.code !== code));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="label">
          의상 컨셉 — 다른 모델 의상을 쓰면 안 됩니다{' '}
          <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
            · 여기 추가하면 이미지 생성 화면의 이 모델 &lsquo;의상&rsquo; 줄에 바로 뜹니다
          </span>
        </div>
        <button onClick={startAdd} className="chip" style={{ color: 'var(--accent)', borderColor: 'var(--accent-dim)' }}>
          + 의상 추가
        </button>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {items.map((o) => (
          <div key={o.code} className="text-center" style={{ width: 92 }}>
            {o.imageUrl ? (
              <Zoomable
                src={o.imageUrl}
                alt={o.desc}
                caption={`${label} · ${o.code} — ${o.desc}`}
                className="w-[92px] rounded-lg border object-cover"
                style={{ aspectRatio: '3/4', borderColor: 'var(--line-strong)', background: 'var(--surface-2)' }}
              />
            ) : (
              // 이미지 없이 글로만 등록한 의상 — 생성에는 문제없다(프롬프트 문장으로 들어간다)
              <div
                className="w-[92px] rounded-lg border border-dashed flex items-center justify-center text-[10px] px-1.5 text-center leading-tight"
                style={{ aspectRatio: '3/4', borderColor: 'var(--line-strong)', color: 'var(--text-mute)' }}
              >
                글로만 지정
              </div>
            )}
            <div className="text-[9.5px] mt-1 font-mono truncate" style={{ color: 'var(--accent)' }}>{o.code}</div>
            <div className="text-[9.5px] leading-tight" style={{ color: 'var(--text-mute)' }}>{o.desc}</div>
            <div className="flex items-center justify-center gap-1 mt-0.5">
              <button onClick={() => startEdit(o)} className="text-[9.5px]" style={{ color: 'var(--text-dim)' }}>수정</button>
              <span className="text-[9.5px]" style={{ color: 'var(--line-strong)' }}>·</span>
              <button onClick={() => remove(o.code)} className="text-[9.5px]" style={{ color: 'var(--danger)' }}>삭제</button>
            </div>
          </div>
        ))}
        {items.length === 0 && !open && (
          <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            등록된 의상이 없습니다 — [+ 의상 추가] 로 넣으면 생성 화면에서 고를 수 있습니다.
          </div>
        )}
      </div>

      {open && (
        <div className="mt-3 p-3 rounded-lg border" style={{ borderColor: 'var(--accent-dim)', background: 'var(--surface-2)' }}>
          <div className="text-[12px] font-bold mb-2">
            {editCode ? `의상 수정 · ${editCode}` : `${label} 의상 추가`}
          </div>

          <div className="label mb-1">자주 쓰는 조합 — 누르면 아래가 채워집니다</div>
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {presets.map((p) => (
              <button key={p.kr} className="chip"
                      onClick={() => setForm((f) => ({ ...f, desc: p.kr, descEn: p.en }))}>
                {p.kr}
              </button>
            ))}
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(160px,1fr) minmax(220px,2fr)' }}>
            <div>
              <div className="label mb-1">의상 이름 (한글)</div>
              <input className="input w-full" value={form.desc} placeholder="예: 크림 니트 + 와이드 슬랙스"
                     onChange={(e) => setForm((f) => ({ ...f, desc: e.target.value }))} />
            </div>
            <div>
              <div className="label mb-1">
                영문 서술 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 비워두면 한글이 그대로 들어갑니다</span>
              </div>
              <input className="input w-full" value={form.descEn} placeholder="a cream knit top with wide-leg trousers"
                     onChange={(e) => setForm((f) => ({ ...f, descEn: e.target.value }))} />
            </div>
          </div>

          <div className="label mt-2.5 mb-1">의상 사진 (선택)</div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="chip cursor-pointer" style={{ color: 'var(--accent)' }}>
              직접 올리기
              <input type="file" accept="image/*" className="hidden"
                     onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
            </label>
            <input className="input flex-1 min-w-[220px]" value={form.imageUrl} placeholder="또는 이미지 주소 붙여넣기 (레퍼런스에서 복사)"
                   onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} />
            {form.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.imageUrl} alt="미리보기" className="w-[52px] h-[68px] object-cover rounded border"
                   style={{ borderColor: 'var(--line-strong)' }} />
            )}
          </div>

          {form.imageUrl && (
            <label className="flex items-start gap-1.5 mt-2 text-[11px] cursor-pointer" style={{ color: 'var(--text-dim)' }}>
              <input type="checkbox" checked={form.useAsRef} className="mt-0.5"
                     onChange={(e) => setForm((f) => ({ ...f, useAsRef: e.target.checked }))} />
              <span>
                이 사진을 <b>생성 참조로도</b> 사용 —{' '}
                <b style={{ color: 'var(--warn)' }}>얼굴이 나오지 않은 의상 컷일 때만</b> 켜세요.
                얼굴이 들어간 사진을 참조로 넣으면 모델 얼굴이 그 사진 쪽으로 바뀝니다.
              </span>
            </label>
          )}

          {err && <div className="text-[11px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}

          <div className="flex items-center gap-2 mt-3">
            <button onClick={save} disabled={busy} className="btn btn-primary">
              {busy ? '저장 중…' : editCode ? '수정 저장' : '의상 추가'}
            </button>
            <button onClick={() => { setOpen(false); setErr(''); }} disabled={busy} className="btn">취소</button>
          </div>
        </div>
      )}
    </div>
  );
}
