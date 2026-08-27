// 숏링크 서비스 — docs/02-architecture.md §10.1·§10.2, docs/03-account-safety.md §5.
//
// 두 가지를 얻으려고 존재한다:
//   ① 채널별 클릭 계측의 소유권 (무신사 정산은 채널 구분이 안 된다)
//   ② 품절 시 과거 게시물의 링크까지 일괄 구제 (게시물을 소급 수정하지 않고 리다이렉트만 바꾼다)
//
// 그리고 절대 하지 않는 것 (레드팀이 '치명'으로 지목한 경로):
//   죽은 링크를 **다른 상품의 커미션 링크로 자동 302** 하지 않는다.
//   사용자가 A를 클릭했는데 B의 커미션 링크에 착지하면, 무신사 로그에는 '클릭 의도와 다른 실적'만
//   보인다 = 링크 스왑/트래픽 전용 패턴 = 큐레이터 자격 상실 직행. 선의와 무관하게 구분 불가능하다.

import { randomBytes } from "node:crypto";
import { db } from "./db";

/** 숏링크가 실리는 지면. 링크허브는 Channel enum에 없으므로 문자열로 통일한다. */
export type Surface = "hub" | "notion" | "kakao_open" | "threads" | "instagram_comment" | "youtube_desc";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CODE_LENGTH = 7;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * 딜×큐레이터링크×채널 조합당 숏링크 1개를 발급(또는 재사용)한다.
 * 같은 딜이라도 카톡용과 허브용 코드가 달라야 어느 채널이 팔았는지 최초 클릭에서 확정된다.
 */
export async function ensureShortLink(params: {
  dealId: string;
  curatorLinkId: string;
  targetUrl: string;
  /** 'hub' | 'notion' | 'kakao_open' | 'threads' … */
  surface: Surface;
}): Promise<string> {
  const existing = await db.shortLink.findUnique({
    where: {
      dealId_curatorLinkId_surface: {
        dealId: params.dealId,
        curatorLinkId: params.curatorLinkId,
        surface: params.surface,
      },
    },
  });
  if (existing) return existing.code;

  // 코드 충돌은 사실상 없지만(62^7), 유니크 제약 위반으로 죽지 않게 몇 번 재시도한다.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const created = await db.shortLink.create({
        data: {
          code,
          dealId: params.dealId,
          curatorLinkId: params.curatorLinkId,
          surface: params.surface,
          targetUrl: params.targetUrl, // 원형 무변조
        },
      });
      return created.code;
    } catch (err) {
      // 재시도할 가치가 있는 것은 유니크 위반(P2002)뿐이다.
      // FK 위반·연결 끊김까지 '충돌'로 삼키면 5회 헛돌다 원인 없는 에러만 남는다.
      if (!isUniqueViolation(err)) throw err;

      // 동시 생성이었다면 이미 만들어진 것을 쓴다
      const raced = await db.shortLink.findUnique({
        where: {
          dealId_curatorLinkId_surface: {
            dealId: params.dealId,
            curatorLinkId: params.curatorLinkId,
            surface: params.surface,
          },
        },
      });
      if (raced) return raced.code;
      // 아니면 code 충돌 — 새 코드로 재시도
    }
  }
  throw new Error("숏링크 코드 발급에 실패했습니다 (코드 충돌 5회).");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export function shortLinkUrl(code: string): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  return base ? `${base.replace(/\/$/, "")}/l/${code}` : null;
}

/**
 * 숏링크 모드 (docs/02 §10.2).
 *
 * **기본값은 safe다.** 무신사에게 "앞단 리다이렉트로 감싸도 되는지" 서면 확인을 받기 전까지는
 * 자기 소유 지면(링크허브·노션)에만 숏링크를 쓰고, 카톡·스레드·IG·유튜브에는 원본 링크를 그대로 노출한다.
 * 확인 없이 전 채널에 미확인 리다이렉트를 뿌리면, 약관 판단이 부정적일 경우 이미 수천 건의
 * 위반 증적이 쌓인 뒤가 된다.
 */
export type ShortlinkMode = "safe" | "full";

export async function getShortlinkMode(): Promise<ShortlinkMode> {
  try {
    const row = await db.policy.findUnique({ where: { key: "shortlinkMode" } });
    return row?.value === "full" ? "full" : "safe";
  } catch {
    return "safe"; // 조회 실패 시 보수적으로
  }
}

/** 자기 소유 지면 — safe 모드에서도 숏링크를 쓰는 곳 */
const OWNED_SURFACES: Surface[] = ["hub", "notion"];

export function usesShortLink(mode: ShortlinkMode, surface: Surface): boolean {
  if (mode === "full") return true;
  return OWNED_SURFACES.includes(surface);
}

// ── 봇 판정 ──────────────────────────────────────────────────────────────
// 봇 클릭을 성과로 집계하면 스코어링이 오염되고, 무신사 쪽에서도 비정상 유입으로 보인다.

const BOT_UA = /bot|crawler|spider|crawl|slurp|facebookexternalhit|preview|curl|wget|python-requests|headless|monitor|scanner|fetch/i;

export function classifyUserAgent(ua: string | null): "human" | "bot" {
  if (!ua || ua.length < 10) return "bot";
  return BOT_UA.test(ua) ? "bot" : "human";
}
