// 크기 비교 막대 — 한 계열(클릭 수)이므로 색은 하나다.
// 이름(왼쪽)과 값(오른쪽)이 모두 글자로 적혀 있어 막대는 "얼마나 차이 나는지"만 거든다:
// 값을 읽으려고 막대 길이를 재거나 툴팁을 띄울 필요가 없다(= 표 보기가 따로 필요 없다).
//
// 규격: 막대는 얇게(10px), 데이터 끝만 4px 둥글고 시작점은 각지게, 눈금선·테두리는 없다.

export interface BarRow {
  label: string;
  value: number;
}

export function MagnitudeBars({
  rows,
  emptyText,
  unit = "회",
}: {
  rows: BarRow[];
  emptyText: string;
  unit?: string;
}) {
  if (rows.length === 0) {
    return <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{emptyText}</p>;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="truncate text-sm">{row.label}</span>
            <span className="shrink-0 text-sm tabular-nums text-muted">
              {row.value.toLocaleString("ko-KR")}
              {unit}
            </span>
          </div>
          <div className="h-2.5 w-full">
            <div
              className="h-2.5 rounded-r-[4px] bg-honey"
              style={{ width: `${Math.max((row.value / max) * 100, 2)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * 상한이 있는 값 하나 — 트랙은 같은 색의 옅은 단계다(칠해진 곳과 빈 곳이 한 덩어리로 읽힌다).
 * 상한에 닿으면 색이 경고로 바뀐다: 여기서 상한은 금지가 아니라 "오늘은 이만"이라는 페이스다.
 */
export function Meter({
  label,
  value,
  limit,
  note,
}: {
  label: string;
  value: number;
  limit: number;
  note?: string;
}) {
  const over = value >= limit;
  const pct = Math.min((value / limit) * 100, 100);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-sm">{label}</span>
        <span className={`text-sm tabular-nums ${over ? "text-danger" : "text-muted"}`}>
          {value} / {limit}
        </span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-honey-soft">
        <div
          className={`h-2.5 rounded-full ${over ? "bg-danger" : "bg-honey"}`}
          style={{ width: `${Math.max(pct, value > 0 ? 4 : 0)}%` }}
        />
      </div>
      {note && <p className="mt-1.5 text-xs text-muted">{note}</p>}
    </div>
  );
}
