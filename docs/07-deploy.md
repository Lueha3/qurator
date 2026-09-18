# 07. 배포 — Vercel + Supabase

> **결정 기록 (2026-09-13)**: VPS를 켜 두고 폴링 봇을 돌리는 대신, **Vercel(호스팅) + Supabase(DB)**로
> 이관했다. `git push` → Vercel이 자동 빌드/배포, DB는 Supabase Postgres 하나만 신경 쓰면 된다.
> 서버 관리(SSH, 프로세스 재시작, 디스크 관리)가 통째로 사라진다.
>
> 코드 쪽 준비는 이미 끝나 있었다: [03-account-safety.md]가 처음부터 요구한 "자격증명 제로·계정 비의존"
> 원칙 덕에 무신사/카카오/Meta 계정에 영향 주는 것 없이 호스팅만 옮기면 됐다. `src/proxy.ts`의
> `APP_ACCESS_TOKEN` 게이트도 이미 있었으므로 "우리만 쓰는 앱"을 위한 추가 작업은 없었다.
>
> **추가 (2026-09-14)**: 텔레그램 봇을 폐기하고 입력·승인을 전부 웹앱으로 옮겼다([02 §6]).
> 봇 토큰·webhook·chat_id 화이트리스트가 사라져 배포 절차도 그만큼 짧아졌다.

---

## 1. 무엇이 바뀌었는가

| 항목 | 이전 (로컬/VPS + 텔레그램) | 이후 (Vercel/Supabase + 웹) |
|---|---|---|
| DB | SQLite 파일(`prisma/dev.db`) | Supabase Postgres |
| 입력 | 텔레그램 봇에 사진 전송(`scripts/bot-poll.ts` 폴링 / webhook) | 웹앱에서 파일 선택 → `POST /api/capture` |
| 여러 장 병합 | `media_group_id` 디바운스 + `AlbumCapture` 테이블 | 한 요청에 여러 파일 — 버퍼 자체가 불필요 |
| 승인 UI | 봇 메시지 편집(`editMessageText`) | 웹 카드 + 서버 액션 (`src/app/actions.ts`) |
| 배포 | 서버에 SSH·pm2/systemd | `git push` → Vercel 자동 빌드 |

이 문서는 **인프라 이관 절차**만 다룬다. 캡처 동작 자체는 [06-screenshot-capture.md] §4.4 참고.

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
   `20260913023212_init_postgres`가 전체 스키마를 만들고, `20260914071923_remove_telegram`이
   텔레그램 전용 컬럼(`telegramChatId`·`telegramMessageId`·`pendingInput`)과 앨범 버퍼 테이블을
   지운다. **이미 Supabase에 데이터를 넣은 뒤라면 이 명령을 한 번 더 실행해 두 번째 마이그레이션을
   적용한다** — 지워지는 것은 텔레그램 전용 필드뿐이라 딜·상품·가격 이력은 그대로 남는다.
   그 이전 SQLite 시절 마이그레이션은 `prisma/migrations-sqlite-archive/`에 이력으로만 남아 있다
   (Postgres에는 적용 불가 — SQL 방언이 다름).

---

## 3. 기존 로컬 데이터 이관 (SQLite → Supabase)

**반드시 데이터 소유자의 PC에서 실행한다.** 두 스크립트 모두 로컬 파일만 읽고 쓰며, 이 저장소나
어떤 채팅 세션도 실제 사업 데이터를 거치지 않는다 — PC에서 Supabase로 직접 올라간다.

```bash
# 0) 이 PC에서 처음 하는 거라면, sqlite 전용 Prisma 클라이언트를 한 번 생성한다
#    (node_modules 안에 생기는 산출물이라 git에는 없다 — 각자 PC에서 직접 만들어야 한다)
SQLITE_DATABASE_URL="file:./dev.db" npx prisma generate --schema=prisma/schema.sqlite-export.prisma

# 1) 옛 dev.db를 JSON으로 통째로 읽는다 (Postgres 전환 후에도 이 스키마로 sqlite를 그대로 읽는다)
SQLITE_DATABASE_URL="file:./dev.db" npm run db:export
#   → migration-dump.json 생성 (.gitignore에 이미 막혀 있음 — 커밋되지 않는다)

# 2) Supabase에 테이블이 이미 있는 상태에서 (§2-4 완료 후) 그 JSON을 그대로 적재한다
DATABASE_URL="<transaction pooler url, 6543>" DIRECT_URL="<session pooler url, 5432>" npm run db:import
```

- id를 원본 UUID 그대로 재사용하므로 관계(FK)가 자동으로 맞는다 — 별도 매핑표가 필요 없다.
- `import`는 대상 DB의 `creators` 테이블이 비어 있을 때만 실행된다(중복 삽입 방지 안전장치).
  재시도해야 하면 Supabase 테이블을 비우고 처음부터 다시 실행한다.
- 텔레그램 시절의 앨범 버퍼 테이블은 이관 대상이 아니었고, 이제 스키마에서도 사라졌다(§2).
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
   | `ANTHROPIC_API_KEY` | Vision 추출용. 없으면 캡처가 "읽지 못했습니다"로 떨어지고 [직접 입력]으로 진행 |
   | `PUBLIC_BASE_URL` | 배포된 Vercel 주소 (예: `https://qurator.vercel.app`) |
   | `APP_ACCESS_TOKEN` | 대시보드 접근 암호. 비면 웹 표면 전체 503(fail closed) |
   | `VAPID_PUBLIC_KEY` | 아침 알림용. `npm run push:keys`로 한 쌍을 만든다. **공개키는 브라우저로 나간다**(그러라고 있는 값) |
   | `VAPID_PRIVATE_KEY` | 같은 쌍의 개인키. 화면·문서·저장소 어디에도 적지 않는다(`APP_ACCESS_TOKEN`과 같은 취급) |
   | `VAPID_SUBJECT` | `mailto:<연락 가능한 주소>`. 푸시 서비스가 장애 시 연락할 곳 |
   | `CRON_SECRET` | Vercel Cron이 `Authorization: Bearer <값>`으로 붙여준다. 비면 크론 주소가 503 |

   VAPID 키 셋이 없으면 아침 알림 기능만 조용히 꺼진다(설정 탭이 "키가 없습니다"라고 알린다).
   **키를 바꾸면 기존 구독이 전부 무효**가 되어 폰에서 알림을 다시 켜야 한다.

3. **마이그레이션은 빌드가 적용한다** (2026-09-15 추가).
   `build` 스크립트가 `prisma generate && prisma migrate deploy && next build`다.
   그 전에는 `prisma generate`만 돌아서, 새 마이그레이션이 생길 때마다 **코드는 배포되는데
   DB 스키마는 그대로**인 상태가 됐다 — `hub_visits` 테이블과 `deals.tags`·`creators.bio`
   컬럼이 없는 채로 V2-B/V2-D 코드가 올라가 `/hub`·`/stats`가 런타임에 깨졌다.
   이제 스키마 적용에 실패하면 **배포 자체가 실패한다**. 스키마가 안 맞는 코드가 뜨는 것보다 낫다.
   - `migrate deploy`는 `DIRECT_URL`(비풀링)을 쓴다 — Vercel 환경변수에 둘 다 있어야 한다.
   - 이미 적용된 마이그레이션은 건너뛴다(멱등). 프리뷰 배포도 같은 DB를 보므로,
     DB를 나누게 되면 이 스크립트를 다시 검토한다.

4. **아침 알림 크론** (2026-09-16 추가). `vercel.json`이 `/api/cron/digest`를 매일
   `0 23 * * *`(UTC) = **08:00 KST**에 부르게 한다. 스케줄은 UTC로 적는다 —
   시간을 바꾸려면 이 한 줄만 고친다. Hobby 플랜은 크론이 하루 1회로 제한되는데, 우리가 원하는 것이
   정확히 그것이다. 발송 여부·이유는 응답 JSON(`status`)과 감사 로그(`push.digest`)에 남으므로,
   알림이 안 왔을 때 Vercel 크론 로그만 보고도 이유를 알 수 있다.

5. 배포 후 `/api/capture` 라우트의 `maxDuration = 60`이 Vercel 플랜의 함수 실행시간 상한 안에
   있는지 확인한다 (Hobby 플랜은 기본 10초라 60초로 늘리려면 Pro가 필요할 수 있다 — Vercel 함수 설정 확인).
   Vision 추출이 20초까지 걸리므로 이 값이 잘리면 캡처가 중간에 끊긴다.

---

## 5. 폰에서 쓰기

배포된 주소를 **한 번만** `https://<주소>/?k=<APP_ACCESS_TOKEN>`으로 연다 — 쿠키가 심어지고
주소창에서 토큰이 즉시 지워진다. 그 뒤 브라우저 메뉴의 "홈 화면에 추가"를 하면 앱 아이콘처럼 열린다.

- **쿠키는 90일이고 쓸 때마다 갱신된다**(슬라이딩 만료, 2026-09-18). 계속 쓰는 한 다시 로그인할
  일이 없다. 고정 만료였을 때는 잘 쓰고 있는데도 어느 날 갑자기 막히는데, 하필 그 순간이
  급할 때 온다.
- **아이폰은 홈 화면 앱과 Safari가 로그인을 따로 기억한다** — 저장 공간이 분리돼 있다.
  홈 화면 앱에서 로그인해 두고 Safari 주소창에 주소를 치면 막히는 것이 정상이다.
  두 곳에서 다 쓰려면 **각각 한 번씩** `?k=`로 열어야 한다.
- 막혔을 때 나오는 401 화면은 흰 화면이 아니라 **다음에 뭘 해야 하는지 적힌 안내**다
  (토큰은 적지 않는다 — 안내가 유출 경로가 되면 안 된다).
- 스크린샷 업로드는 파일 선택창에서 **사진첩 → 방금 찍은 스크린샷**을 고르는 흐름이다(카메라 아님).

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
