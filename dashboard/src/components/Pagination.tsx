import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 500];

interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  onChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}

export function Pagination({ total, page, pageSize, onChange, onPageSizeChange }: PaginationProps) {
  const totalPages = Math.ceil(total / pageSize);
  const from = Math.min(page * pageSize + 1, total);
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
      <div className="flex items-center gap-3">
        <span>
          {total === 0 ? '0' : `${from}–${to}`} of {total}
        </span>
        {onPageSizeChange && (
          <div className="flex items-center gap-1.5">
            <span>Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-7 rounded border border-input bg-background px-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {PAGE_SIZE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {totalPages > 1 && (
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
      )}
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
