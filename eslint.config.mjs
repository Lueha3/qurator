import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // 계정 보호 불변식을 린트로 강제한다 (docs/03-account-safety.md §4, §9 Never List).
    // 아웃바운드 HTTP는 Fetch Gateway 한 곳만 통과해야 전역 레이트리밋·차단감지·킬스위치가 성립한다.
    // 서버 코드에서 fetch()를 직접 부르면 그 관문이 무력화되므로 금지한다.
    files: ["src/lib/**/*.ts", "src/app/api/**/*.ts", "scripts/**/*.ts"],
    ignores: ["src/lib/fetch-gateway.ts", "src/lib/**/__tests__/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "서버 코드에서 fetch()를 직접 호출하지 마세요. 무신사로 나가는 요청은 gatewayFetch()를 통과해야 합니다 (docs/03-account-safety.md §4). 텔레그램 등 다른 API는 전용 클라이언트 모듈을 사용하세요.",
        },
      ],
    },
  },
]);

export default eslintConfig;
