import Link from 'next/link';
import { NEW_VIDEO_BADGE_MS, isRecent } from '@/lib/recent';
import type { VideoFolder, VideoRow } from '@/components/VideoGallery';

/**
 * 레퍼런스 제작물 목록 — 폴더(기획안 한 편)마다 소개 → 묶음(편집본 · AI 생성 장면 …)별 카드.
 * 영상 제작물(VideoGallery)과 카드 모양은 같지만 보기 전용이다. 등록·이름 바꾸기는 대화에서 한다
 * (시험작이 계속 바뀌어 화면에서 고칠 일이 적고, 영상 파일 업로드는 어차피 대화에서 한다).
 */

const GRID = { gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' };

function Card({ v }: { v: VideoRow }) {
  const fresh = isRecent(v.createdAt, undefined, NEW_VIDEO_BADGE_MS) || isRecent(v.fileAt, undefined, NEW_VIDEO_BADGE_MS);
  return (
    <div className="card p-2.5">
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
        <div className="text-[12.5px] font-bold leading-snug">
          {fresh && (
            <span className="inline-block align-[1px] mr-1.5 text-[9.5px] font-bold leading-none px-1.5 py-[3px] rounded-full"
                  style={{ background: 'var(--accent)', color: '#fff' }} title="최근 사흘 안에 올라온 영상">N</span>
          )}
          {v.title}
        </div>
        {v.summary && <div className="text-[11.5px] mt-1 leading-relaxed">{v.summary}</div>}
        {v.note && (
          <details className="mt-1">
            <summary className="text-[10.5px] cursor-pointer" style={{ color: 'var(--text-mute)' }}>자세히</summary>
            <div className="text-[11px] mt-1 leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-dim)' }}>{v.note}</div>
          </details>
        )}
        <div className="flex items-center mt-1.5">
          <div className="flex-1" />
          <a className="text-[10.5px]" href={v.src} target="_blank" rel="noreferrer" style={{ color: 'var(--text-mute)' }}>새 창</a>
        </div>
      </div>
    </div>
  );
}

function FolderBlock({ name, videos, folders, linkTitle }: {
  name: string; videos: VideoRow[]; folders: VideoFolder[]; linkTitle: boolean;
}) {
  const meta = folders.find((f) => f.name === name);
  const inside = videos.filter((v) => v.folder === name);
  // 묶음 순서는 폴더 설정을 따르고, 설정에 없는 묶음은 뒤에 붙인다
  const order = [...(meta?.sections.map((s) => s.project) ?? []), ...inside.map((v) => v.project)];
  const sections = [...new Set(order)].filter((p) => inside.some((v) => v.project === p));
  return (
    <section className="mb-9">
      {linkTitle && (
        <h2 className="text-[15px] font-extrabold tracking-tight mb-2">
          {meta?.slug ? <Link href={`/ideas/works/${meta.slug}`}>📁 {name}</Link> : <>📁 {name}</>}
          <span className="ml-1.5 font-normal text-[12px]" style={{ color: 'var(--text-mute)' }}>{inside.length}</span>
        </h2>
      )}
      {meta?.desc && (
        <div className="card p-3.5 mb-5 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{meta.desc}</div>
      )}
      {sections.map((p) => {
        const list = inside.filter((v) => v.project === p);
        const desc = meta?.sections.find((s) => s.project === p)?.desc;
        return (
          <div key={p || '-'} className="mb-7">
            <div className="text-[13.5px] font-bold">
              {p || '묶음 없음'} <span className="font-normal" style={{ color: 'var(--text-mute)' }}>{list.length}</span>
            </div>
            {desc && <div className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{desc}</div>}
            <div className="grid gap-3.5 mt-2.5" style={GRID}>{list.map((v) => <Card key={v.id} v={v} />)}</div>
          </div>
        );
      })}
    </section>
  );
}

/** only 를 주면 그 폴더 하나만, 없으면 영상이 든 폴더 전부 (설정 순서 → 설정에 없는 폴더) */
export default function IdeaWorks({ videos, folders, only }: { videos: VideoRow[]; folders: VideoFolder[]; only?: string }) {
  const names = only
    ? [only]
    : [...new Set([...folders.map((f) => f.name), ...videos.map((v) => v.folder).filter(Boolean)])]
      .filter((f) => videos.some((v) => v.folder === f));
  if (names.length === 0) {
    return (
      <div className="card p-6 text-center text-[12px]" style={{ color: 'var(--text-mute)' }}>
        아직 올라온 레퍼런스 영상이 없습니다.
      </div>
    );
  }
  return <>{names.map((n) => <FolderBlock key={n} name={n} videos={videos} folders={folders} linkTitle={!only} />)}</>;
}
