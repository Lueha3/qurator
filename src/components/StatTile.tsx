import Link from "next/link";

// 통계 타일 — 값 하나 + 직전 기간 대비 변화. 한 칸짜리 막대그래프를 그리지 않는다(숫자가 곧 차트다).
//
// 변화량 색: 올라가면 ok, 내려가거나 같으면 muted다. **빨강을 쓰지 않는다** —
// 클릭이 지난주보다 적은 것은 경보가 아니라 사실이고, 1인 사용자에게 매주 빨간 숫자를
// 보여주면 그 색이 진짜 경고(품절·고지 실패)와 구분되지 않는다.

function formatDelta(value: number, prev: number): { text: string; up: boolean } | null {
  if (value === 0 && prev === 0) return null;
  const diff = value - prev;
  if (diff === 0) return { text: "지난 기간과 같음", up: false };
  return { text: `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff).toLocaleString("ko-KR")}`, up: diff > 0 };
}

// 비교 기준("직전 7일 대비")은 타일마다 적지 않는다 — 폰 폭 3열에서 줄이 밀려 타일 높이가
// 제각각이 되고, 어차피 세 타일이 같은 기준이라 화면에 한 번만 적으면 된다.
export function StatTile({
  label,
  value,
  prev,
  href,
}: {
  label: string;
  value: number;
  /** 직전 같은 길이의 기간 값. 주면 변화량을 함께 보여준다 */
  prev?: number;
  href?: string;
}) {
  const delta = prev === undefined ? null : formatDelta(value, prev);

  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      {/* 큰 숫자에는 tabular-nums를 쓰지 않는다 — 자릿폭이 같아져 121 같은 값이 헐거워 보인다 */}
      <div className="mt-0.5 text-2xl font-semibold">{value.toLocaleString("ko-KR")}</div>
      {delta && (
        <div className={`mt-0.5 text-[11px] ${delta.up ? "text-ok" : "text-muted"}`}>{delta.text}</div>
      )}
    </>
  );

  if (!href) return <div className="rounded-xl border border-line bg-panel px-3 py-3">{body}</div>;
  return (
    <Link href={href} className="rounded-xl border border-line bg-panel px-3 py-3 transition-colors hover:border-honey">
      {body}
    </Link>
  );
}
