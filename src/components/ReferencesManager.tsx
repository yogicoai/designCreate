'use client';

import { useRef, useState } from 'react';
import Zoomable from '@/components/Zoomable';
import { shrinkForUpload, formatBytes } from '@/lib/client-image';
import type { ReferenceDoc } from '@/lib/queries';

/**
 * 자산관리 > 레퍼런스 — 업로드(등록) + 목록 관리.
 * 생성 화면(/create)의 보관함과 같은 컬렉션(references)을 쓴다.
 */
export default function ReferencesManager({ initial }: { initial: ReferenceDoc[] }) {
  const [items, setItems] = useState<ReferenceDoc[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setErr(''); setNote('');
    try {
      for (const f of Array.from(files).slice(0, 8)) {
        const shrunk = await shrinkForUpload(f);
        if (shrunk.bytes !== shrunk.originalBytes) {
          setNote(`${f.name}: ${formatBytes(shrunk.originalBytes)} → ${formatBytes(shrunk.bytes)} 로 줄여서 업로드`);
        }
        const fd = new FormData();
        fd.append('file', shrunk.file);
        fd.append('title', f.name);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.ok) {
          setItems((cur) => [
            { url: json.url, title: json.title, width: json.width, height: json.height, createdAt: new Date().toISOString() },
            ...cur.filter((x) => x.url !== json.url),
          ]);
        } else setErr(json.error || '업로드 실패');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
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

  async function remove(url: string) {
    if (!window.confirm('보관함에서 숨길까요? (이미 생성에 쓰인 이미지는 영향 없음)')) return;
    const res = await fetch('/api/references', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if ((await res.json()).ok) setItems((cur) => cur.filter((x) => x.url !== url));
  }

  return (
    <div>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      <div className="card p-4 mb-5 flex items-center gap-3 flex-wrap">
        <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? '업로드 중…' : '＋ 레퍼런스 등록'}
        </button>
        <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
          큰 사진도 그대로 올리면 됩니다 — 자동으로 줄여서 /web/design/update/ 에 저장됩니다.
        </span>
        {note && <span className="text-[11px]" style={{ color: 'var(--ok)' }}>{note}</span>}
        {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
      </div>

      {items.length === 0 ? (
        <div className="card p-8 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
          아직 등록된 레퍼런스가 없습니다.
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {items.map((r) => (
            <div key={r.url}>
              <Zoomable
                src={r.url}
                alt={r.title}
                caption={`${r.title}${r.width ? ` · ${r.width}×${r.height}` : ''}`}
                className="w-full aspect-square object-cover rounded-lg border"
                style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
              />
              <div className="mt-1 flex items-center justify-between gap-1">
                <button
                  onClick={() => rename(r.url, r.title)}
                  title="클릭해서 이름 변경"
                  className="text-[10.5px] truncate text-left flex-1"
                  style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  {r.title || '(이름 없음)'}
                </button>
                <button
                  onClick={() => remove(r.url)}
                  className="text-[10.5px] shrink-0"
                  style={{ color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  숨김
                </button>
              </div>
              <div className="text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                {String(r.createdAt ?? '').slice(0, 10)}{r.width ? ` · ${r.width}×${r.height}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
