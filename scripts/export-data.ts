// 구 로컬 SQLite(dev.db) → Supabase(Postgres) 이관용 1회성 export 스크립트.
//
// 반드시 이 PC(현표님 PC)에서만 실행한다 — 실제 사업 데이터가 이 스크립트를 통해
// 어디로도 전송되지 않고, 로컬 JSON 파일 하나로만 떨어진다(네트워크 요청 없음).
// 이 JSON은 절대 커밋하지 않는다 (.gitignore에 이미 막혀 있음).
//
// 실행 순서:
//   1) (이 브랜치로 갈아타기 전) 지금 쓰던 커밋에서 아무것도 안 해도 됨 — 이 스크립트는
//      메인 schema.prisma가 postgresql로 바뀐 뒤에도 별도 스키마(schema.sqlite-export.prisma)로
//      옛 dev.db를 그대로 읽는다.
//   2) SQLITE_DATABASE_URL=file:./prisma/dev.db npx prisma generate --schema=prisma/schema.sqlite-export.prisma
//   3) SQLITE_DATABASE_URL=file:./prisma/dev.db npx tsx scripts/export-data.ts
//   4) 생성된 migration-dump.json을 확인 후 scripts/import-data.ts로 넘긴다.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const sqliteUrl = process.env.SQLITE_DATABASE_URL;
  if (!sqliteUrl) {
    console.error(
      "SQLITE_DATABASE_URL이 없습니다. 예: SQLITE_DATABASE_URL=file:./prisma/dev.db npx tsx scripts/export-data.ts"
    );
    process.exit(1);
  }

  // 메인 @prisma/client(postgresql)와 절대 혼동되지 않게 별도 생성 경로에서 가져온다.
  const { PrismaClient } = await import(
    "../node_modules/.prisma-sqlite-export-client/index.js"
  );
  const src = new PrismaClient();

  try {
    // FK 순서는 읽기에는 의미 없다 — export는 각 테이블을 통째로 읽기만 한다.
    const [
      policy,
      circuitState,
      fetchLog,
      auditLog,
      creator,
      product,
      productVariant,
      priceSnapshot,
      watchItem,
      deal,
      curatorLink,
      contentCard,
      post,
      shortLink,
      clickEvent,
    ] = await Promise.all([
      src.policy.findMany(),
      src.circuitState.findMany(),
      src.fetchLog.findMany(),
      src.auditLog.findMany(),
      src.creator.findMany(),
      src.product.findMany(),
      src.productVariant.findMany(),
      src.priceSnapshot.findMany(),
      src.watchItem.findMany(),
      src.deal.findMany(),
      src.curatorLink.findMany(),
      src.contentCard.findMany(),
      src.post.findMany(),
      src.shortLink.findMany(),
      src.clickEvent.findMany(),
    ]);

    // album_captures/album_capture_photos는 일부러 뺀다 — 처리 중 임시 버퍼일 뿐이라
    // 이관 시점엔 이미 소진돼 있어야 정상이고, 설령 남아 있어도 새로 시작해도 무방하다.

    const dump = {
      exportedAt: new Date().toISOString(),
      counts: {
        policy: policy.length,
        circuitState: circuitState.length,
        fetchLog: fetchLog.length,
        auditLog: auditLog.length,
        creator: creator.length,
        product: product.length,
        productVariant: productVariant.length,
        priceSnapshot: priceSnapshot.length,
        watchItem: watchItem.length,
        deal: deal.length,
        curatorLink: curatorLink.length,
        contentCard: contentCard.length,
        post: post.length,
        shortLink: shortLink.length,
        clickEvent: clickEvent.length,
      },
      data: {
        policy,
        circuitState,
        fetchLog,
        auditLog,
        creator,
        product,
        productVariant,
        priceSnapshot,
        watchItem,
        deal,
        curatorLink,
        contentCard,
        post,
        shortLink,
        clickEvent,
      },
    };

    const outPath = resolve(__dirname, "../migration-dump.json");
    writeFileSync(outPath, JSON.stringify(dump, null, 2), "utf-8");

    console.log("[export] 완료:", outPath);
    console.table(dump.counts);
  } finally {
    await src.$disconnect();
  }
}

main().catch((err) => {
  console.error("[export] 실패", err);
  process.exit(1);
});
