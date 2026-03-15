import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  onChange: (page: number) => void;
}

export function Pagination({ total, page, pageSize, onChange }: PaginationProps) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  const from = page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  // Show up to 5 page buttons centred around current page
  const windowSize = 5;
  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, page - half);
  const end = Math.min(totalPages, start + windowSize);
  start = Math.max(0, end - windowSize);
  const pages = Array.from({ length: end - start }, (_, i) => start + i);

  return (
    <div className="flex items-center justify-between px-1 py-2 text-sm text-muted-foreground">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page === 0}
          className="p-1 rounded hover:bg-muted disabled:opacity-40 transition-colors"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {start > 0 && (
          <>
            <PageButton n={0} current={page} onClick={onChange} />
            {start > 1 && <span className="px-1">…</span>}
          </>
        )}

        {pages.map((n) => (
          <PageButton key={n} n={n} current={page} onClick={onChange} />
        ))}

        {end < totalPages && (
          <>
            {end < totalPages - 1 && <span className="px-1">…</span>}
            <PageButton n={totalPages - 1} current={page} onClick={onChange} />
          </>
        )}

        <button
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages - 1}
          className="p-1 rounded hover:bg-muted disabled:opacity-40 transition-colors"
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PageButton({ n, current, onClick }: { n: number; current: number; onClick: (n: number) => void }) {
  return (
    <button
      onClick={() => onClick(n)}
      className={`min-w-[2rem] h-8 px-2 rounded text-sm transition-colors ${
        n === current
          ? 'bg-primary text-primary-foreground font-medium'
          : 'hover:bg-muted'
      }`}
    >
      {n + 1}
    </button>
  );
}
