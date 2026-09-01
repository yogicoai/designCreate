'use client';

import { useRef, useState } from 'react';
import Zoomable from '@/components/Zoomable';
import { shrinkForUpload, formatBytes } from '@/lib/client-image';
import type { ReferenceDoc } from '@/lib/queries';

/**
 * 자산관리 > 레퍼런스 — 등록·이름변경·이미지 교체·숨김·완전 삭제.
 * 생성 화면(/create)의 보관함과 같은 컬렉션(references)을 쓴다.
 *
 * 숨김 = 목록에서만 제거 (파일 유지 — 생성 이력이 참조할 수 있음)
 * 삭제 = DB + FTP 파일까지 제거. 생성 컷 기록에 쓰였으면 한 번 더 확인받는다.
 *        디자인 빌더(eventTemp)에서 가져온 항목은 파일이 그쪽 자산이라 목록에서만 빠진다.
 */

const CATEGORY_KR: Record<string, string> = {
  'web-banner': '웹 배너',
  sns: 'SNS',
  'sns-story': '스토리/릴스',
  mobile: '모바일',
  thumbnail: '썸네일',
};

export default function ReferencesManager({ initial }: { initial: ReferenceDoc[] }) {
  const [items, setItems] = useState<ReferenceDoc[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<string>('');
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  /** 이미지 교체 대상 URL — 교체용 파일창이 닫힐 때 참조 */
  const replaceTarget = useRef<string>('');

  async function uploadOne(f: File, replaceUrl?: string) {
    const shrunk = await shrinkForUpload(f);
    if (shrunk.bytes !== shrunk.originalBytes) {
      setNote(`${f.name}: ${formatBytes(shrunk.originalBytes)} → ${formatBytes(shrunk.bytes)} 로 줄여서 업로드`);
    }
    const fd = new FormData();
    fd.append('file', shrunk.file);
    fd.append('title', f.name);
    if (replaceUrl) fd.append('replaceUrl', replaceUrl);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    return res.json();
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setErr(''); setNote('');
    try {
      for (const f of Array.from(files).slice(0, 8)) {
        const json = await uploadOne(f);
        if (json.ok) {
          setItems((cur) => [
            { url: json.url, title: json.title, width: json.width, height: json.height, category: null, tags: [], source: 'upload', createdAt: new Date().toISOString() },
            ...cur.filter((x) => x.url !== json.url),
          ]);
        } else setErr(json.error || '업로드 실패');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** 이미지 교체 — 항목(이름·분류)은 유지하고 파일만 갈아끼운다 */
  async function onReplaceFile(files: FileList | null) {
    const target = replaceTarget.current;
    replaceTarget.current = '';
    if (!files?.length || !target) return;
    setUploading(true); setErr(''); setNote('');
    try {
      const json = await uploadOne(files[0], target);
      if (json.ok) {
        setItems((cur) => cur.map((x) => (x.url === target ? { ...x, url: json.url, width: json.width, height: json.height } : x)));
        setNote('이미지가 교체됐습니다. (이름·분류는 유지)');
      } else setErr(json.error || '교체 실패');
    } finally {
      setUploading(false);
      if (replaceInput.current) replaceInput.current.value = '';
    }
  }

  async function rename(url: string, current: string) {
    const title = window.prompt('레퍼런스 이름', current);
    if (title == null || title === current) return;
    const res = await fetch('/api/references', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, title }),
    });
    if ((await res.json()).ok) setItems((cur) => cur.map((x) => (x.url === url ? { ...x, title } : x)));
  }

  async function hide(url: string) {
    if (!window.confirm('보관함에서 숨길까요? 파일은 유지됩니다.')) return;
    const res = await fetch('/api/references', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if ((await res.json()).ok) setItems((cur) => cur.filter((x) => x.url !== url));
  }

  async function hardDelete(url: string, source: string) {
    const msg = source === 'eventtemp'
      ? '디자인 빌더에서 가져온 항목입니다. 파일은 그쪽 자산이라 남고, 이 보관함에서만 완전히 빠집니다. 삭제할까요?'
      : '완전히 삭제할까요? FTP 파일까지 지워지며 되돌릴 수 없습니다.';
    if (!window.confirm(msg)) return;

    const call = (force: boolean) => fetch('/api/references', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, hard: true, ...(force ? { force: true } : {}) }),
    }).then((r) => r.json());

    let json = await call(false);
    if (!json.ok && json.needsForce) {
      if (!window.confirm(`${json.error}\n\n그래도 삭제할까요?`)) return;
      json = await call(true);
    }
    if (json.ok) setItems((cur) => cur.filter((x) => x.url !== url));
    else setErr(json.error || '삭제 실패');
  }

  const categories = [...new Set(items.map((x) => x.category).filter(Boolean))] as string[];
  const shown = filter ? items.filter((x) => x.category === filter) : items;

  return (
    <div>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      <input ref={replaceInput} type="file" accept="image/*" hidden onChange={(e) => onReplaceFile(e.target.files)} />

      <div className="card p-4 mb-4 flex items-center gap-3 flex-wrap">
        <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? '처리 중…' : '＋ 레퍼런스 등록'}
        </button>
        <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
          큰 사진도 그대로 올리면 됩니다 — 자동으로 줄여서 저장됩니다.
        </span>
        {note && <span className="text-[11px]" style={{ color: 'var(--ok)' }}>{note}</span>}
        {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
      </div>

      {categories.length > 0 && (
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          <span className="label mr-1">분류</span>
          <button className="chip" onClick={() => setFilter('')}
                  style={!filter ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
            전체 ({items.length})
          </button>
          {categories.map((c) => (
            <button key={c} className="chip" onClick={() => setFilter(c === filter ? '' : c)}
                    style={filter === c ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
              {CATEGORY_KR[c] ?? c} ({items.filter((x) => x.category === c).length})
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card p-8 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
          {items.length === 0 ? '아직 등록된 레퍼런스가 없습니다.' : '이 분류에는 항목이 없습니다.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5">
          {shown.map((r) => (
            <div key={r.url}>
              <div className="relative">
                <Zoomable
                  src={r.url}
                  alt={r.title}
                  caption={`${r.title}${r.width ? ` · ${r.width}×${r.height}` : ''}`}
                  className="w-full aspect-square object-cover rounded-lg border"
                  style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
                />
                {r.source === 'eventtemp' && (
                  <span className="absolute top-1 left-1 text-[8.5px] px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(0,0,0,.55)', color: '#9fd1ff' }}>
                    디자인 빌더
                  </span>
                )}
                {r.category && (
                  <span className="absolute bottom-1 left-1 text-[8.5px] px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(0,0,0,.55)', color: '#ddd' }}>
                    {CATEGORY_KR[r.category] ?? r.category}
                  </span>
                )}
              </div>
              <button
                onClick={() => rename(r.url, r.title)}
                title="클릭해서 이름 변경"
                className="mt-1 text-[10.5px] truncate text-left w-full"
                style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {r.title || '(이름 없음)'}
              </button>
              <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-mute)' }}>
                <button onClick={() => { replaceTarget.current = r.url; replaceInput.current?.click(); }}
                        style={{ color: 'var(--info)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  교체
                </button>
                <button onClick={() => hide(r.url)}
                        style={{ color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  숨김
                </button>
                <button onClick={() => hardDelete(r.url, r.source)}
                        style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  삭제
                </button>
                <span className="ml-auto">{String(r.createdAt ?? '').slice(0, 10)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
