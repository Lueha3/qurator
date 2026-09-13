// scripts/export-data.ts가 만든 migration-dump.json을 Supabase(Postgres)로 적재하는
// 1회성 import 스크립트. 반드시 이 PC(현표님 PC)에서, export 직후에 실행한다.
//
// 실행 전 준비:
//   - Supabase 프로젝트 설정 → Database → Connection string에서
//     Transaction pooler(6543)를 DATABASE_URL, Direct connection(5432)을 DIRECT_URL로 넣는다.
//   - prisma/schema.prisma가 이미 postgresql을 가리키므로 npx prisma migrate deploy로
//     Supabase에 테이블을 먼저 만들어 둔다 (docs/07-deploy.md).
//
// 실행:
//   DATABASE_URL="postgresql://...:6543/postgres?pgbouncer=true" \
//   DIRECT_URL="postgresql://...:5432/postgres" \
//   npx tsx scripts/import-data.ts
//
// id를 원본 UUID 그대로 다시 넣으므로(재발급하지 않음) 관계형 FK 문자열도 그대로 유지된다 —
// 별도의 ID 매핑표가 필요 없다. 그 대신 FK가 가리키는 부모 테이블을 먼저 채워야 하므로
// 아래 순서(부모→자식)를 반드시 지킨다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../src/lib/db";

function maskedHost(url: string | undefined): string {
  if (!url) return "(미설정)";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "?"}`;
  } catch {
    return "(파싱 실패)";
  }
}

async function main() {
  const dumpPath = process.argv[2] ?? resolve(__dirname, "../migration-dump.json");
  const dump = JSON.parse(readFileSync(dumpPath, "utf-8"));

  console.log(`[import] 대상: ${maskedHost(process.env.DATABASE_URL)}`);
  console.log(`[import] 덤프: ${dumpPath} (exportedAt=${dump.exportedAt})`);
  console.table(dump.counts);

  // 이미 데이터가 있는 DB에 또 부으면 unique 제약 충돌 또는 중복 행이 생긴다.
  // 재실행은 반드시 Supabase 쪽 테이블을 비우고(또는 새 프로젝트로) 다시 해야 한다.
  const existingCreators = await db.creator.count();
  if (existingCreators > 0) {
    console.error(
      `[import] 중단: creators 테이블에 이미 ${existingCreators}건이 있습니다. ` +
        "중복 삽입을 막기 위해 빈 DB에만 import합니다. Supabase 테이블을 비운 뒤 다시 실행하세요."
    );
    process.exit(1);
  }

  const d = dump.data;

  // 부모 → 자식 순서. FK가 가리키는 테이블이 먼저 채워져 있어야 한다.
  const steps: Array<[string, () => Promise<{ count: number }>]> = [
    ["policy", () => db.policy.createMany({ data: d.policy })],
    ["circuitState", () => db.circuitState.createMany({ data: d.circuitState })],
    ["fetchLog", () => db.fetchLog.createMany({ data: d.fetchLog })],
    ["auditLog", () => db.auditLog.createMany({ data: d.auditLog })],
    ["creator", () => db.creator.createMany({ data: d.creator })],
    ["product", () => db.product.createMany({ data: d.product })],
    ["productVariant", () => db.productVariant.createMany({ data: d.productVariant })],
    ["priceSnapshot", () => db.priceSnapshot.createMany({ data: d.priceSnapshot })],
    ["watchItem", () => db.watchItem.createMany({ data: d.watchItem })],
    ["deal", () => db.deal.createMany({ data: d.deal })],
    ["curatorLink", () => db.curatorLink.createMany({ data: d.curatorLink })],
    ["contentCard", () => db.contentCard.createMany({ data: d.contentCard })],
    ["post", () => db.post.createMany({ data: d.post })],
    ["shortLink", () => db.shortLink.createMany({ data: d.shortLink })],
    ["clickEvent", () => db.clickEvent.createMany({ data: d.clickEvent })],
  ];

  for (const [name, run] of steps) {
    const rows = d[name as keyof typeof d] as unknown[];
    if (!rows || rows.length === 0) {
      console.log(`[import] ${name}: 0건 (건너뜀)`);
      continue;
    }
    const result = await run();
    console.log(`[import] ${name}: ${result.count}건 적재`);
  }

  console.log("[import] 완료. 앱에서 데이터가 정상 조회되는지 확인하세요.");
}

main()
  .catch((err) => {
    console.error("[import] 실패 — 아래 오류가 난 테이블까지만 적재됐을 수 있습니다.", err);
    console.error(
      "재시도 전 Supabase 테이블을 비우고(TRUNCATE) 처음부터 다시 실행하세요."
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
