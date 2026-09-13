import { execSync } from "node:child_process";

// 통합 테스트용 Postgres DB. 로컬 개발용 dev.db(이제는 dev용 Postgres 인스턴스)와
// 분리해 테스트가 실제 작업 데이터를 건드리지 않게 한다.
// TEST_DATABASE_URL이 없으면 로컬 기본값(직접 설치한 Postgres)을 쓴다 — 매 머신마다
// docker/설치 방식이 달라도 이 문서화된 기본값 하나만 맞추면 테스트가 돌아간다.
const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/qurator_test";
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

// 안전장치: 이 스크립트는 스키마를 통째로 DROP한다. 실수로 Supabase(운영 DB) 문자열이
// 여기 흘러들어오면 현표님의 실제 데이터가 지워진다 — 절대 예외 없이 막는다.
if (TEST_DATABASE_URL.includes("supabase.co")) {
  throw new Error(
    "TEST_DATABASE_URL이 Supabase를 가리키고 있습니다. 테스트는 반드시 로컬 Postgres에서 실행하세요."
  );
}

export default function setup() {
  // 이전 실행의 잔여 테이블을 스키마째로 날리고 새로 만든다 — SQLite 시절 rmSync(파일 삭제)에
  // 대응하는 Postgres 방식. `prisma db execute`는 psql 바이너리 없이도 동작한다.
  execSync(`npx prisma db execute --url "${TEST_DATABASE_URL}" --stdin`, {
    input: "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
    stdio: ["pipe", "pipe", "pipe"],
  });

  execSync("npx prisma migrate deploy", {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL,
    },
    stdio: "pipe",
  });

  // 테스트 프로세스가 이 DB를 보도록 설정
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DIRECT_URL = TEST_DATABASE_URL;
}
