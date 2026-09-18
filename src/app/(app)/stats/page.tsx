import Link from "next/link";
import { KAKAO_DAILY_LIMIT, loadStats, type StatsPeriod } from "@/lib/stats";
import { PageHeader } from "@/components/PageHeader";
import { StatTile } from "@/components/StatTile";
import { MagnitudeBars, Meter } from "@/components/MagnitudeBars";
import { segmentCls, segmentItemCls } from "@/components/form";

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
      <PageHeader title="성과" subtitle="링크가 얼마나 눌렸는지, 카톡에 몇 번 올렸는지 봐요." />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pb-6 pt-2">
        {/* 기간은 이 화면 전체에 걸린다 — 카드마다 따로 두지 않는다 */}
        <div className={`w-max ${segmentCls}`}>
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={p === 7 ? "/stats" : `/stats?p=${p}`}
              aria-current={p === days ? "page" : undefined}
              className={segmentItemCls(p === days)}
            >
              최근 {p}일
            </Link>
          ))}
        </div>

        <section className="grid grid-cols-3 gap-2">
          <StatTile label="링크 클릭" value={stats.clicks.value} prev={stats.clicks.prev} />
          <StatTile label="카톡에 올림" value={stats.posts.value} prev={stats.posts.prev} />
          <StatTile label="페이지 방문" value={stats.hubVisits.value} prev={stats.hubVisits.prev} />
        </section>
        <p className="-mt-4 text-xs text-ink-soft">
          ▲▼는 {periodLabel} 변화예요. 봇 클릭은 뺐고, “카톡에 올림”은 문구를 복사한 횟수예요.
        </p>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">어디서 눌렸나</h2>
          <MagnitudeBars rows={stats.bySurface} emptyText={`최근 ${days}일 동안 눌린 링크가 없어요.`} />
        </section>

        <section className="card p-4">
          <h2 className="mb-1 text-sm font-semibold">많이 눌린 딜</h2>
          <p className="mb-3 text-xs text-ink-soft">다음에 뭘 더 올릴지 여기서 힌트를 얻어요.</p>
          <MagnitudeBars
            rows={stats.topDeals.map((d) => ({ label: `${d.brand} · ${d.productName}`, value: d.clicks }))}
            emptyText={`최근 ${days}일 동안 눌린 딜이 없어요.`}
          />
        </section>

        <section className="card p-4">
          <h2 className="mb-1 text-sm font-semibold">팔로워 페이지</h2>
          <p className="mb-3 text-xs text-ink-soft">
            {stats.hubCtr === null
              ? "아직 방문이 없어요. 프로필 링크를 팔로워 페이지로 바꾸면 여기에 쌓여요."
              : `방문 ${stats.hubVisits.value.toLocaleString("ko-KR")}번 중 ${stats.hubClicks.toLocaleString("ko-KR")}번이 상품 링크로 이어졌어요.`}
          </p>
          {stats.hubCtr !== null && (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold">{stats.hubCtr}%</span>
              <span className="text-xs text-ink-soft">방문 대비 클릭</span>
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">오늘 카톡에 올린 횟수</h2>
          <Meter
            label="오늘 올린 문구"
            value={stats.kakaoToday}
            limit={KAKAO_DAILY_LIMIT}
            note="하루 3~5개가 적당해요. 막지는 않지만, 너무 잦으면 방을 나가는 사람이 늘어요."
          />
        </section>
      </main>
    </>
  );
}
