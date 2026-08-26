import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

// 통합 테스트용 SQLite DB를 매 실행마다 새로 만든다.
// 개발용 dev.db와 분리해 테스트가 실제 작업 데이터를 건드리지 않게 한다.
const TEST_DB_PATH = resolve(__dirname, "../../prisma/test.db");
const TEST_DB_URL = "file:./test.db";

export default function setup() {
  rmSync(TEST_DB_PATH, { force: true });
  rmSync(`${TEST_DB_PATH}-journal`, { force: true });

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: "pipe",
  });

  // 테스트 프로세스가 이 DB를 보도록 설정
  process.env.DATABASE_URL = TEST_DB_URL;

  return () => {
    rmSync(TEST_DB_PATH, { force: true });
    rmSync(`${TEST_DB_PATH}-journal`, { force: true });
  };
}
