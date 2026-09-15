// Postgres → Postgres 데이터 이관 (예: Supabase → Neon, 또는 그 반대).
// 반드시 데이터 소유자의 PC에서 실행한다. 두 DB 모두 이미 공개된 클라우드 서비스이므로
// 스크립트 자체는 이 저장소·세션이 아니라 실행하는 PC에서 로컬로 오간다.
//
// SQLite→Postgres 이관(export-data.ts/import-data.ts)과 달리 여기서는 두 쪽 다 Postgres라
// 중간 JSON 파일 없이 Prisma 클라이언트 2개(각자 다른 datasource URL)로 직접 복사한다.
//
// 실행 전 준비:
//   1) 새 DB(TARGET)에 테이블을 먼저 만든다:
//      DATABASE_URL="<target pooled>" DIRECT_URL="<target direct>" npx prisma migrate deploy
//   2) 이 스크립트를 돌린다 (아래).
//
// 실행 (SOURCE_URL·TARGET_URL 둘 다 pooled 연결 문자열로 충분 — 마이그레이션이 아니라
// 일반 쿼리라 PgBouncer 트랜잭션 모드로도 동작한다):
//   SOURCE_DATABASE_URL="postgresql://...supabase.../postgres?pgbouncer=true" \
//   TARGET_DATABASE_URL="postgresql://...neon.tech/...?sslmode=require" \
//   npx tsx scripts/copy-postgres-data.ts
//
// id를 원본 그대로 복사하므로(재발급하지 않음) 관계형 FK 문자열도 그대로 유지된다.

import { PrismaClient } from "@prisma/client";

function maskedHost(url: string | undefined): string {
  if (!url) return "(미설정)";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "?"}`;
  } catch {
    return "(파싱 실패)";
  }
}

// 부모 → 자식 순서. FK가 가리키는 테이블이 먼저 채워져 있어야 target에 쓸 수 있다.
const TABLES = [
  "policy",
  "circuitState",
  "fetchLog",
  "auditLog",
  "creator",
  "product",
  "productVariant",
  "priceSnapshot",
  "watchItem",
  "deal",
  "curatorLink",
  "contentCard",
  "post",
  "shortLink",
  "clickEvent",
] as const;

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl || !targetUrl) {
    console.error(
      "SOURCE_DATABASE_URL과 TARGET_DATABASE_URL이 둘 다 필요합니다.\n" +
        '예: SOURCE_DATABASE_URL="..." TARGET_DATABASE_URL="..." npx tsx scripts/copy-postgres-data.ts'
    );
    process.exit(1);
  }
  if (sourceUrl === targetUrl) {
    console.error("SOURCE와 TARGET이 같은 주소입니다 — 실수 방지를 위해 중단합니다.");
    process.exit(1);
  }

  const source = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
  const target = new PrismaClient({ datasources: { db: { url: targetUrl } } });

  try {
    console.log(`[copy] source: ${maskedHost(sourceUrl)}`);
    console.log(`[copy] target: ${maskedHost(targetUrl)}`);

    // target에 이미 데이터가 있으면 또 부어 중복·유니크 충돌을 만들 수 있다.
    const existing = await target.creator.count();
    if (existing > 0) {
      console.error(
        `[copy] 중단: target의 creators 테이블에 이미 ${existing}건이 있습니다. ` +
          "빈 DB에만 복사합니다. target 테이블을 비운 뒤 다시 실행하세요."
      );
      process.exit(1);
    }

    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      // 모델별 delegate에 동적으로 접근한다 — 두 클라이언트 모두 같은 스키마이므로 안전하다.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 테이블마다 다른 delegate 타입을 순회하려면 필요하다
      const sourceDelegate = source[table] as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const targetDelegate = target[table] as any;

      const rows: unknown[] = await sourceDelegate.findMany();
      counts[table] = rows.length;
      if (rows.length === 0) {
        console.log(`[copy] ${table}: 0건 (건너뜀)`);
        continue;
      }
      await targetDelegate.createMany({ data: rows });
      console.log(`[copy] ${table}: ${rows.length}건 복사`);
    }

    console.log("[copy] 완료. 앱에서 데이터가 정상 조회되는지 확인하세요.");
    console.table(counts);
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
}

main().catch((err) => {
  console.error("[copy] 실패 — 아래 오류가 난 테이블까지만 복사됐을 수 있습니다.", err);
  console.error("재시도 전 target 테이블을 비우고(TRUNCATE) 처음부터 다시 실행하세요.");
  process.exit(1);
});
