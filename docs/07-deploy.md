# 07. 배포 — Vercel + Supabase

> **결정 기록 (2026-09-13)**: VPS를 켜 두고 폴링 봇을 돌리는 대신, **Vercel(호스팅) + Supabase(DB)**로
> 이관했다. `git push` → Vercel이 자동 빌드/배포, DB는 Supabase Postgres 하나만 신경 쓰면 된다.
> 서버 관리(SSH, 프로세스 재시작, 디스크 관리)가 통째로 사라진다.
>
> 코드 쪽 준비는 이미 끝나 있었다: [03-account-safety.md]가 처음부터 요구한 "자격증명 제로·계정 비의존"
> 원칙 덕에 무신사/카카오/Meta 계정에 영향 주는 것 없이 호스팅만 옮기면 됐다. `src/middleware.ts`의
> `APP_ACCESS_TOKEN` 게이트도 이미 있었으므로 "우리만 쓰는 앱"을 위한 추가 작업은 없었다.

---

## 1. 무엇이 바뀌었는가

| 항목 | 이전 (로컬/VPS) | 이후 (Vercel/Supabase) |
|---|---|---|
| DB | SQLite 파일(`prisma/dev.db`) | Supabase Postgres |
| 텔레그램 수신 | `scripts/bot-poll.ts` 장시간 폴링(`getUpdates`) | `/api/telegram/webhook` (Vercel Function) |
| 앨범(여러 장) 버퍼 | 프로세스 메모리 `Map` | DB 테이블(`AlbumCapture`/`AlbumCapturePhoto`) — 서버리스 인스턴스가 메모리를 공유하지 않으므로 |
| 응답 뒤 후속 작업(Vision 등) | 그냥 `await` (장시간 실행 프로세스) | `next/server`의 `after()` — 응답을 먼저 돌려주고 그 뒤에 이어 실행 |
| 배포 | 서버에 SSH·pm2/systemd | `git push` → Vercel 자동 빌드 |

세 가지 코드 변경(webhook의 `after()`, 앨범 버퍼의 DB 이전, `defer` 주입 패턴)은 [06-screenshot-capture.md] §4.4.1에
정리돼 있다. 이 문서는 **인프라 이관 절차**만 다룬다.

---

## 2. Supabase 프로젝트 설정

1. [supabase.com](https://supabase.com)에서 프로젝트 생성 (무료 티어로 충분 — [04-roadmap.md] 비용표).
2. **Settings → Database → Connection string**에서 두 개를 복사한다:
   - **Transaction pooler** (포트 6543) → `.env`의 `DATABASE_URL`. 앱 런타임(서버리스 함수 다수)이 이걸 쓴다.
   - **Session pooler** (포트 5432, pooler 호스트) → `.env`의 `DIRECT_URL`. `prisma migrate`만 이걸 쓴다.
     (PgBouncer 트랜잭션 모드는 마이그레이션이 필요로 하는 advisory lock을 지원하지 않는다.)
     **"Direct connection"(`db.<project-ref>.supabase.co`)을 쓰지 않는다** — IPv6 전용이라 IPv6이 안
     되는 네트워크(흔한 가정용 회선 포함)에서 `P1001: Can't reach database server`로 실패한다.
     Session pooler는 같은 pooler 호스트의 5432 포트라 IPv4로도 접속되고, 세션 단위 기능(advisory
     lock 등)도 지원해 마이그레이션에 문제없다.
3. `prisma/schema.prisma`의 `datasource db`가 이미 이 두 값을 읽도록 돼 있다 — 스키마 수정은 필요 없다.
4. 테이블 생성 (Windows `cmd`는 `set VAR=값` 후 `npx ...`, macOS/Linux는 아래처럼 한 줄로):
   ```bash
   DATABASE_URL="<transaction pooler url, 6543>" DIRECT_URL="<session pooler url, 5432>" npx prisma migrate deploy
   ```
   `prisma/migrations/20260913023212_init_postgres`가 전체 스키마(17개 모델)를 한 번에 만든다.
   그 이전 SQLite 시절 마이그레이션은 `prisma/migrations-sqlite-archive/`에 이력으로만 남아 있다
   (Postgres에는 적용 불가 — SQL 방언이 다름).

---

## 3. 기존 로컬 데이터 이관 (SQLite → Supabase)

**반드시 데이터 소유자의 PC에서 실행한다.** 두 스크립트 모두 로컬 파일만 읽고 쓰며, 이 저장소나
어떤 채팅 세션도 실제 사업 데이터를 거치지 않는다 — PC에서 Supabase로 직접 올라간다.

```bash
# 0) 이 PC에서 처음 하는 거라면, sqlite 전용 Prisma 클라이언트를 한 번 생성한다
#    (node_modules 안에 생기는 산출물이라 git에는 없다 — 각자 PC에서 직접 만들어야 한다)
SQLITE_DATABASE_URL="file:./prisma/dev.db" npx prisma generate --schema=prisma/schema.sqlite-export.prisma

# 1) 옛 dev.db를 JSON으로 통째로 읽는다 (Postgres 전환 후에도 이 스키마로 sqlite를 그대로 읽는다)
SQLITE_DATABASE_URL="file:./prisma/dev.db" npm run db:export
#   → migration-dump.json 생성 (.gitignore에 이미 막혀 있음 — 커밋되지 않는다)

# 2) Supabase에 테이블이 이미 있는 상태에서 (§2-4 완료 후) 그 JSON을 그대로 적재한다
DATABASE_URL="<transaction pooler url, 6543>" DIRECT_URL="<session pooler url, 5432>" npm run db:import
```

- id를 원본 UUID 그대로 재사용하므로 관계(FK)가 자동으로 맞는다 — 별도 매핑표가 필요 없다.
- `import`는 대상 DB의 `creators` 테이블이 비어 있을 때만 실행된다(중복 삽입 방지 안전장치).
  재시도해야 하면 Supabase 테이블을 비우고 처음부터 다시 실행한다.
- `AlbumCapture`/`AlbumCapturePhoto`(스크린샷 앨범 임시 버퍼)는 의도적으로 이관 대상에서 뺐다 —
  처리 중에만 잠깐 쓰는 행이라 새로 시작해도 무방하다.
- 두 스크립트 모두 [scripts/export-data.ts]·[scripts/import-data.ts]에 상세 절차가 코드 주석으로 있다.

---

## 4. Vercel 배포

1. Vercel 프로젝트에 GitHub 저장소를 연결한다 (Settings → Git → Connect Repository).
   깃허브 연동이 끊긴 상태로 배포됐다면 재연결하거나, 기존 배포를 지우고 다시 import한다.
2. **Environment Variables**에 아래를 전부 등록한다 (`.env.example` 참고):

   | 변수 | 비고 |
   |---|---|
   | `DATABASE_URL` | Supabase Transaction pooler (6543) |
   | `DIRECT_URL` | Supabase Session pooler (5432) — "Direct connection"이 아님, §2 참고 |
   | `ANTHROPIC_API_KEY` | Vision 추출용. 없으면 그레이스풀 디그레이드 |
   | `TELEGRAM_BOT_TOKEN` | BotFather 발급 |
   | `TELEGRAM_ALLOWED_CHAT_IDS` | 비우면 봇이 전 메시지 거부(fail closed) |
   | `TELEGRAM_WEBHOOK_SECRET` | 아래 §5에서 `setWebhook`에 넣을 값과 동일해야 함 |
   | `PUBLIC_BASE_URL` | 배포된 Vercel 주소 (예: `https://qurator.vercel.app`) |
   | `APP_ACCESS_TOKEN` | 대시보드 접근 암호. 비면 웹 표면 전체 503(fail closed) |
   | `APP_SECRET` | 복사 웹뷰 링크 HMAC 서명용 |

3. 배포 후 `/api/telegram/webhook` 라우트의 `maxDuration = 60`이 Vercel 플랜의 함수 실행시간 상한 안에
   있는지 확인한다 (Hobby 플랜은 기본 10초라 60초로 늘리려면 Pro가 필요할 수 있다 — Vercel 함수 설정 확인).

---

## 5. 텔레그램 webhook 전환

로컬 폴링(`npm run bot`)과 프로덕션 webhook은 같은 봇 토큰에서 동시에 켤 수 없다(409 Conflict).
배포가 끝나면 webhook으로 전환한다:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<vercel-domain>/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

`secret_token`은 Vercel에 등록한 `TELEGRAM_WEBHOOK_SECRET`과 정확히 같아야 한다 — 다르면
webhook route가 전부 403으로 거부한다(의도된 동작, §의 `secretMatches` 참고).

이후 로컬에서 다시 폴링 개발을 하려면 `npm run bot`이 시작 시 자동으로 `deleteWebhook`을 호출하니
별도 해제 작업은 필요 없다. 로컬 개발이 끝나면 위 `setWebhook`을 다시 호출해 프로덕션을 복구한다.

---

## 6. 테스트 (로컬 Postgres)

통합 테스트는 실제 DB에 붙는다(상태 머신 전이 검증). SQLite 파일 대신 **로컬 Postgres**가 필요하다.

- 기본값: `postgresql://postgres:postgres@localhost:5432/qurator_test` (`src/test/global-setup.ts`).
  다른 값을 쓰려면 `TEST_DATABASE_URL` 환경변수로 덮어쓴다.
- **안전장치**: `TEST_DATABASE_URL`에 `supabase.co`가 들어있으면 테스트가 즉시 에러로 중단된다 —
  이 스크립트는 스키마를 통째로 `DROP`하므로, 실수로 운영 Supabase를 겨냥하면 데이터가 전부 날아간다.
- 매 실행마다 `DROP SCHEMA public CASCADE` 후 `prisma migrate deploy`로 새로 만든다 — SQLite 시절
  파일 삭제(`rmSync`)에 대응하는 Postgres 방식.

```bash
npm test
```
