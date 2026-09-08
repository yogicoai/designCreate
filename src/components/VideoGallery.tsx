'use client';

import { useState } from 'react';

/**
 * 영상 갤러리 — 완성된 영상을 모아 보는 곳.
 *
 * 파일은 cafe24 에 .jpg 로 위장 저장돼 있다 (cafe24 가 .mp4 업로드를 막는다).
 * 재생은 /api/video 프록시가 video/mp4 로 바꿔 흘려보내므로 브라우저에선 그냥 영상이다.
 */

export interface VideoRow {
  id: string;
  title: string;
  note: string;
  project: string;
  aspect: string;
  key: string;
  src: string;
  poster: string;
  createdAt: string | null;
}

const ASPECTS = ['9:16', '1:1', '16:9'];

export default function VideoGallery({ initial }: { initial: VideoRow[] }) {
  const [items, setItems] = useState<VideoRow[]>(initial);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', key: '', note: '', project: '', aspect: '9:16' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState('');
  const [editTitle, setEditTitle] = useState('');

  // 목록은 서버에서 받은 초기값으로 그리고, 변경 뒤에는 이걸로 다시 맞춘다
  async function reload() {
    const json = await (await fetch('/api/videos')).json();
    if (json.ok) setItems(json.videos);
  }

  const projects = [...new Set(items.map((v) => v.project).filter(Boolean))];
  const shown = filter ? items.filter((v) => v.project === filter) : items;

  async function add() {
    if (!form.title.trim() || !form.key.trim()) { setErr('제목과 영상 주소가 필요합니다.'); return; }
    setBusy(true); setErr('');
    try {
      const json = await (await fetch('/api/videos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      })).json();
      if (!json.ok) throw new Error(json.error || '등록 실패');
      setForm({ title: '', key: '', note: '', project: '', aspect: '9:16' });
      setAdding(false);
      await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function saveTitle(id: string) {
    setBusy(true);
    try {
      await fetch('/api/videos', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title: editTitle }),
      });
      setEditId(''); await reload();
    } finally { setBusy(false); }
  }

  async function remove(v: VideoRow) {
    if (!confirm(`"${v.title}" 을 갤러리에서 뺄까요? 서버의 영상 파일은 그대로 남습니다.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/videos?id=${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      await reload();
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button className="chip" style={!filter ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                onClick={() => setFilter('')}>
          전체 {items.length}
        </button>
        {projects.map((p) => (
          <button key={p} className="chip" onClick={() => setFilter(p)}
                  style={filter === p ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
            {p} {items.filter((v) => v.project === p).length}
          </button>
        ))}
        <div className="flex-1" />
        <button className="btn" onClick={() => { setAdding((v) => !v); setErr(''); }}>
          {adding ? '닫기' : '+ 영상 등록'}
        </button>
      </div>

      {adding && (
        <div className="card p-3.5 mb-4">
          <div className="text-[12px] font-bold mb-2">영상 등록</div>
          <div className="text-[11.5px] leading-relaxed mb-2.5" style={{ color: 'var(--text-dim)' }}>
            서버에 이미 올라간 영상의 주소를 넣습니다. cafe24 는 .mp4 업로드를 막기 때문에
            영상은 <b>.jpg 로 위장해</b> 올라가 있고, 재생은 이 앱의 프록시가 처리합니다 —
            그래서 주소가 <span className="font-mono">…/web/design/video/이름.jpg</span> 처럼 보이는 게 정상입니다.
            <br />내 PC 의 영상 파일을 올리려면 대화에서 &ldquo;이 영상 갤러리에 올려줘&rdquo; 라고 하시면 됩니다
            (수십 MB 라 브라우저 업로드 한도를 넘습니다).
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(180px,1fr) minmax(180px,1fr)' }}>
            <div>
              <div className="label mb-1">제목</div>
              <input className="input w-full" value={form.title} placeholder="가족 요기보 3탄 — 노는 자리"
                     onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            </div>
            <div>
              <div className="label mb-1">묶음 이름 (선택)</div>
              <input className="input w-full" value={form.project} placeholder="가족 CF"
                     onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))} />
            </div>
          </div>
          <div className="label mt-2 mb-1">영상 주소</div>
          <input className="input w-full" value={form.key}
                 placeholder="https://yogibo.openhost.cafe24.com/web/design/video/....jpg"
                 onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
          <div className="flex items-end gap-2 mt-2">
            <div className="flex-1">
              <div className="label mb-1">메모 (선택)</div>
              <input className="input w-full" value={form.note} placeholder="15초 · 음원 A안 확정본"
                     onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
            <div>
              <div className="label mb-1">비율</div>
              <div className="flex gap-1">
                {ASPECTS.map((a) => (
                  <button key={a} className="chip" onClick={() => setForm((f) => ({ ...f, aspect: a }))}
                          style={form.aspect === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {err && <div className="text-[11px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
          <button className="btn btn-primary mt-3" onClick={add} disabled={busy}>
            {busy ? '등록 중…' : '등록'}
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card p-6 text-center text-[12px]" style={{ color: 'var(--text-mute)' }}>
          아직 등록된 영상이 없습니다.
        </div>
      ) : (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {shown.map((v) => (
            <div key={v.id} className="card p-2.5">
              <video
                src={v.src}
                poster={v.poster || undefined}
                controls
                loop
                playsInline
                preload="metadata"
                className="w-full rounded-lg"
                style={{ aspectRatio: v.aspect.replace(':', '/'), background: '#000', objectFit: 'contain' }}
              />
              <div className="mt-2">
                {editId === v.id ? (
                  <div className="flex items-center gap-1.5">
                    <input className="input flex-1" value={editTitle} autoFocus
                           onChange={(e) => setEditTitle(e.target.value)}
                           onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(v.id); if (e.key === 'Escape') setEditId(''); }} />
                    <button className="chip" onClick={() => saveTitle(v.id)} disabled={busy}>저장</button>
                  </div>
                ) : (
                  <div className="text-[12.5px] font-bold leading-snug">{v.title}</div>
                )}
                {v.note && (
                  <div className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{v.note}</div>
                )}
                <div className="flex items-center gap-1.5 mt-1.5">
                  {v.project && <span className="chip" style={{ color: 'var(--info)' }}>{v.project}</span>}
                  <div className="flex-1" />
                  <button className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}
                          onClick={() => { setEditId(v.id); setEditTitle(v.title); }}>이름</button>
                  <a className="text-[10.5px]" href={v.src} target="_blank" rel="noreferrer"
                     style={{ color: 'var(--text-mute)' }}>새 창</a>
                  <button className="text-[10.5px]" style={{ color: 'var(--danger)' }}
                          onClick={() => remove(v)}>빼기</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
