import Link from "next/link";
import { KAKAO_DAILY_LIMIT, loadStats, type StatsPeriod } from "@/lib/stats";
import { PageHeader } from "@/components/PageHeader";
import { StatTile } from "@/components/StatTile";
import { MagnitudeBars, Meter } from "@/components/MagnitudeBars";

// 성과 — docs/08 §3.3 / §2.2 G2.
// 클릭·발행은 이미 쌓이고 있었고 읽는 화면만 없었다. DB만 읽는다(무신사 요청 0건).
export const dynamic = "force-dynamic";

const PERIODS: StatsPeriod[] = [7, 30];

export default async function StatsPage({ searchParams }: PageProps<"/stats">) {
  const params = await searchParams;
  const raw = Array.isArray(params.p) ? params.p[0] : params.p;
  const days: StatsPeriod = raw === "30" ? 30 : 7;
  const stats = await loadStats(days);
  const periodLabel = `직전 ${days}일 대비`;

  return (
    <>
      <PageHeader title="성과" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-4">
        {/* 기간은 이 화면 전체에 걸린다 — 카드마다 따로 두지 않는다 */}
        <div className="flex gap-1.5">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={p === 7 ? "/stats" : `/stats?p=${p}`}
              aria-current={p === days ? "page" : undefined}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                p === days ? "border-honey bg-honey-soft font-medium text-honey" : "border-line bg-panel text-muted"
              }`}
            >
              최근 {p}일
            </Link>
          ))}
        </div>

        <section className="grid grid-cols-3 gap-2">
          <StatTile label="클릭" value={stats.clicks.value} prev={stats.clicks.prev} />
          <StatTile label="발행" value={stats.posts.value} prev={stats.posts.prev} />
          <StatTile label="허브 방문" value={stats.hubVisits.value} prev={stats.hubVisits.prev} />
        </section>
        <p className="-mt-4 text-xs text-muted">
          ▲▼는 {periodLabel} 변화입니다. 봇으로 분류된 클릭·방문은 빠진 숫자이고, 발행은 카드를 복사해
          실제로 내보낸 횟수입니다.
        </p>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">지면별 클릭</h2>
          <MagnitudeBars rows={stats.bySurface} emptyText={`최근 ${days}일 동안 클릭이 없습니다.`} />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">많이 눌린 딜</h2>
          <p className="mb-3 text-xs text-muted">다음에 무엇을 더 올릴지는 이 목록이 알려줍니다.</p>
          <MagnitudeBars
            rows={stats.topDeals.map((d) => ({ label: `${d.brand} · ${d.productName}`, value: d.clicks }))}
            emptyText={`최근 ${days}일 동안 눌린 딜이 없습니다.`}
          />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">링크허브</h2>
          <p className="mb-3 text-xs text-muted">
            {stats.hubCtr === null
              ? "아직 방문 기록이 없습니다. 프로필 링크를 허브로 바꾸면 여기에 쌓입니다."
              : `방문 ${stats.hubVisits.value.toLocaleString("ko-KR")}회 중 ${stats.hubClicks.toLocaleString("ko-KR")}회가 상품 링크로 이어졌습니다.`}
          </p>
          {stats.hubCtr !== null && (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold">{stats.hubCtr}%</span>
              <span className="text-xs text-muted">방문 대비 클릭</span>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">오늘의 카톡 페이스</h2>
          <Meter
            label="오픈채팅에 내보낸 카드"
            value={stats.kakaoToday}
            limit={KAKAO_DAILY_LIMIT}
            note="하루 3~5건이 권고 상한입니다. 막지는 않지만, 너무 잦으면 방 이탈이 늘어납니다."
          />
        </section>
      </main>
    </>
  );
}
