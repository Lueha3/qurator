import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
  test: {
    // 통합 테스트는 실제 SQLite 파일에 붙는다 — 상태 머신 전이를 진짜 DB로 검증하기 위해.
    globalSetup: ["./src/test/global-setup.ts"],
    // DB를 공유하므로 파일 간 병렬 실행을 끈다.
    fileParallelism: false,
  },
});
