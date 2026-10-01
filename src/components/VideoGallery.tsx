'use client';

import Link from 'next/link';
import { useState } from 'react';

/**
 * 영상 갤러리 — 완성된 영상을 모아 보는 곳.
 *
 * 파일은 cafe24 에 .jpg 로 위장 저장돼 있다 (cafe24 가 .mp4 업로드를 막는다).
 * 재생은 /api/video 프록시가 video/mp4 로 바꿔 흘려보내므로 브라우저에선 그냥 영상이다.
 *
 * 폴더(2026-10-01, 사용자 요청 「리뉴얼 영상 제작」): folder 가 붙은 영상은 '전체'에서 빠지고
 * 폴더를 열면 묶음(project)별로 — 묶음 소개 + 제작 순서대로 — 보인다. 폴더·묶음 소개는 settings.video_folders.
 * 카드는 짧은 과정 설명(summary)을 먼저 보이고, 긴 기술 메모(note)는 '자세히'로 접는다.
 * 폴더마다 주소가 있다(/video/gallery/[slug]) — 왼쪽 메뉴 '영상 제작물' 아래 하위 폴더와 폴더 칩이 그 주소로 간다.
 */

export interface VideoRow {
  id: string;
  title: string;
  note: string;
  project: string;
  folder: string;
  summary: string;
  aspect: string;
  key: string;
  src: string;
  poster: string;
  createdAt: string | null;
}

export interface VideoFolder {
  name: string;
  /** 주소에 쓰는 이름 — /video/gallery/renewal. 없으면 칩으로만 연다 */
  slug?: string;
  desc: string;
  sections: { project: string; desc: string }[];
}

const ASPECTS = ['9:16', '1:1', '16:9'];
const ACTIVE = { borderColor: 'var(--accent)', color: 'var(--accent)' };

export default function VideoGallery({ initial, folders = [], initialFolder = '' }: {
  initial: VideoRow[];
  folders?: VideoFolder[];
  /** 폴더 주소로 들어왔을 때 처음부터 열어 둘 폴더 이름 */
  initialFolder?: string;
}) {
  const [items, setItems] = useState<VideoRow[]>(initial);
  const [filter, setFilter] = useState('');
  const [folder, setFolder] = useState(initialFolder);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', key: '', note: '', project: '', aspect: '9:16' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [openNotes, setOpenNotes] = useState<string[]>([]);

  // 목록은 서버에서 받은 초기값으로 그리고, 변경 뒤에는 이걸로 다시 맞춘다
  async function reload() {
    const json = await (await fetch('/api/videos')).json();
    if (json.ok) setItems(json.videos);
  }

  const loose = items.filter((v) => !v.folder);
  const folderNames = [...new Set([...folders.map((f) => f.name), ...items.map((v) => v.folder).filter(Boolean)])]
    .filter((f) => items.some((v) => v.folder === f));
  const projects = [...new Set(loose.map((v) => v.project).filter(Boolean))];
  const shown = filter ? loose.filter((v) => v.project === filter) : loose;

  function pick(nextFolder: string, nextFilter: string) {
    setFolder(nextFolder);
    setFilter(nextFilter);
  }

  function toggleNote(id: string) {
    setOpenNotes((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

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

  function card(v: VideoRow) {
    const open = openNotes.includes(v.id);
    return (
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
          {v.summary ? (
            <>
              <div className="text-[11.5px] mt-1 leading-relaxed">{v.summary}</div>
              {v.note && (
                <button className="text-[10.5px] mt-1" style={{ color: 'var(--text-mute)' }} onClick={() => toggleNote(v.id)}>
                  {open ? '자세히 접기 ▴' : '자세히 ▾'}
                </button>
              )}
              {v.note && open && (
                <div className="text-[11px] mt-1 leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-dim)' }}>{v.note}</div>
              )}
            </>
          ) : v.note && (
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
    );
  }

  const GRID = { gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' };

  // 폴더 안 — 묶음 순서는 폴더 설정을 따르고, 설정에 없는 묶음은 뒤에 붙인다
  function folderView(name: string) {
    const meta = folders.find((f) => f.name === name);
    const inside = items.filter((v) => v.folder === name);
    const order = [...(meta?.sections.map((s) => s.project) ?? []), ...inside.map((v) => v.project)];
    const sections = [...new Set(order)].filter((p) => inside.some((v) => v.project === p));
    return (
      <div>
        {meta?.desc && (
          <div className="card p-3.5 mb-5 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{meta.desc}</div>
        )}
        {sections.map((p) => {
          const list = inside.filter((v) => v.project === p);
          const desc = meta?.sections.find((s) => s.project === p)?.desc;
          return (
            <section key={p || '-'} className="mb-7">
              <div className="text-[13.5px] font-bold">
                {p || '묶음 없음'} <span className="font-normal" style={{ color: 'var(--text-mute)' }}>{list.length}</span>
              </div>
              {desc && (
                <div className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{desc}</div>
              )}
              <div className="grid gap-3.5 mt-2.5" style={GRID}>{list.map(card)}</div>
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        {/* 폴더 주소로 들어온 화면에서 '전체'는 영상 제작물 첫 화면으로 돌아간다 */}
        {initialFolder ? (
          <Link href="/video/gallery" className="chip">전체 {loose.length}</Link>
        ) : (
          <button className="chip" style={!filter && !folder ? ACTIVE : {}} onClick={() => pick('', '')}>
            전체 {loose.length}
          </button>
        )}
        {folderNames.map((f) => {
          const slug = folders.find((x) => x.name === f)?.slug;
          const label = <>📁 {f} {items.filter((v) => v.folder === f).length}</>;
          return slug ? (
            <Link key={f} href={`/video/gallery/${slug}`} className="chip font-bold" style={folder === f ? ACTIVE : {}}>
              {label}
            </Link>
          ) : (
            <button key={f} className="chip font-bold" onClick={() => pick(f, '')} style={folder === f ? ACTIVE : {}}>
              {label}
            </button>
          );
        })}
        {/* 묶음 칩은 '전체'(폴더 밖 영상)를 거르는 것 — 폴더 화면에선 안 보인다 */}
        {!initialFolder && projects.map((p) => (
          <button key={p} className="chip" onClick={() => pick('', p)} style={filter === p ? ACTIVE : {}}>
            {p} {loose.filter((v) => v.project === p).length}
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
            <br />내 PC 의 영상 파일을 올리려면 대화에서 &ldquo;영상 제작물에 올려줘&rdquo; 라고 하시면 됩니다
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

      {folder ? folderView(folder) : shown.length === 0 ? (
        <div className="card p-6 text-center text-[12px]" style={{ color: 'var(--text-mute)' }}>
          아직 등록된 영상이 없습니다.
        </div>
      ) : (
        <div className="grid gap-3.5" style={GRID}>{shown.map(card)}</div>
      )}
    </div>
  );
}
