export default function PageHeader({
  title,
  desc,
  right,
}: {
  title: string;
  desc?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-[22px] font-extrabold tracking-tight">{title}</h1>
        {desc && (
          <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            {desc}
          </p>
        )}
      </div>
      {right}
    </header>
  );
}
