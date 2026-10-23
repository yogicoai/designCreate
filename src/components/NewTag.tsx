import { isNewFeature, type NewFeature } from '@/lib/new-features';

/** 새 기능 표시 — 기한(lib/new-features.ts)이 지나면 아무것도 그리지 않는다 */
export default function NewTag({ feature }: { feature: NewFeature }) {
  if (!isNewFeature(feature)) return null;
  return (
    <span
      title="새로 추가된 기능입니다"
      className="inline-block align-middle text-[9px] font-bold leading-none px-1 py-[2px] rounded"
      style={{ color: '#fff', background: 'var(--accent)', letterSpacing: '0.04em' }}
    >
      NEW
    </span>
  );
}
