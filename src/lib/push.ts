// 웹 푸시 — docs/08 §4.0.5 (V2-G). "앱을 열지 않아도 오늘 할 일을 안다."
//
// 보내는 것은 **하루 한 통, 숫자 몇 개뿐**이다. 상품명·가격·링크를 싣지 않는다:
//   ① 잠금화면 알림은 옆 사람도 본다. 어떤 상품을 밀 계획인지가 거기 뜰 이유가 없다.
//   ② 알림에 내용이 많을수록 "읽고 끝"이 된다. 우리가 원하는 건 앱을 여는 것이다.
//   ③ 커미션 링크는 어떤 경우에도 앱 밖으로 새지 않는다(proxy.ts와 같은 원칙).
//
// 할 일이 하나도 없는 날은 **보내지 않는다**. 매일 오는 "할 일 없음"은 몇 번 만에 전부 무시된다.

import webpush from "web-push";
import { db } from "./db";
import { audit } from "./audit";
import { loadDeadLinkAlerts } from "./dashboard";
import { dueForReminder } from "./watch-remind";
import { isCrawlessMode } from "./policy";

/** 감사 로그에 남는 액션 이름. 하루 1회 제한이 이 기록을 기준으로 동작한다. */
export const DIGEST_ACTION = "push.digest";

/** 이 횟수만큼 연속 실패하면 구독을 버린다. 만료(404/410)는 기다리지 않고 즉시 버린다. */
const MAX_FAIL = 5;

// ── 설정 ────────────────────────────────────────────────────────────────

export interface PushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * VAPID 키. 없으면 null — 푸시 기능 전체가 조용히 꺼진다(500을 내지 않는다).
 * 개인키는 절대 화면·응답에 싣지 않는다. 공개키만 브라우저로 나간다(그러라고 있는 값이다).
 */
export function pushKeys(): PushKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  // mailto:는 푸시 서비스가 장애 시 연락할 곳이다. 없으면 표준이 요구하는 형식만 채운다.
  const subject = process.env.VAPID_SUBJECT || "mailto:qurator@example.com";
  return { publicKey, privateKey, subject };
}

/** 브라우저에 넘길 공개키만 돌려준다. 서버 컴포넌트가 이걸 프롭으로 내린다. */
export function pushPublicKey(): string | null {
  return pushKeys()?.publicKey ?? null;
}

// ── 구독 저장 ───────────────────────────────────────────────────────────

export interface RawSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * 브라우저가 준 구독 정보를 검증한다. 클라이언트가 보낸 값이므로 **믿지 않는다** —
 * 여기서 걸러내지 않으면 임의의 주소로 우리 서버가 요청을 보내는 발판이 된다(SSRF).
 * 푸시 서비스 endpoint는 항상 https다.
 */
export function validateSubscription(raw: unknown): RawSubscription | null {
  if (!raw || typeof raw !== "object") return null;
  const sub = raw as Record<string, unknown>;

  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  // 푸시 서비스(Apple·Google·Mozilla…)는 언제나 공개 DNS 이름을 쓴다. IP 리터럴과 점 없는
  // 호스트(localhost 등)를 막아, **우리 서버가 내부 주소를 두드리는 경로를 만들지 않는다** —
  // fetch-gateway의 SSRF 방어와 같은 이유다(docs/03). 게이트 뒤라고 해서 예외를 두지 않는다.
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return null; // localhost, 내부 단일 라벨 호스트
  if (host.startsWith("[")) return null; // IPv6 리터럴
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // IPv4 리터럴

  const keys = sub.keys as Record<string, unknown> | undefined;
  const p256dh = keys && typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = keys && typeof keys.auth === "string" ? keys.auth.trim() : "";
  // base64url만 허용 — 길이는 브라우저마다 달라 상한만 둔다.
  const base64url = /^[A-Za-z0-9_-]+=*$/;
  if (!p256dh || p256dh.length > 200 || !base64url.test(p256dh)) return null;
  if (!auth || auth.length > 100 || !base64url.test(auth)) return null;

  return { endpoint, keys: { p256dh, auth } };
}

/** 알림 목록에서 "이게 어느 기기지"를 알아볼 수 있게 하는 이름. UA에서 추정만 한다. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/iPhone/i.test(ua)) return "아이폰";
  if (/iPad/i.test(ua)) return "아이패드";
  if (/Android/i.test(ua)) return "안드로이드";
  if (/Macintosh/i.test(ua)) return "맥";
  if (/Windows/i.test(ua)) return "PC";
  return "기기";
}

export async function saveSubscription(raw: unknown, userAgent: string | null): Promise<boolean> {
  const sub = validateSubscription(raw);
  if (!sub) return false;

  // 같은 폰이 다시 켜면 endpoint가 같다 — 새 행을 만들지 않고 키만 갱신한다.
  await db.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: {
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      label: deviceLabel(userAgent),
    },
    update: {
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      label: deviceLabel(userAgent),
      failCount: 0,
    },
  });

  await audit({
    actor: "HUMAN",
    action: "push.subscribed",
    detail: `${deviceLabel(userAgent)}에서 아침 알림을 켰습니다`,
  });
  return true;
}

export async function removeSubscription(endpoint: unknown): Promise<boolean> {
  if (typeof endpoint !== "string" || !endpoint) return false;
  const { count } = await db.pushSubscription.deleteMany({ where: { endpoint } });
  if (count > 0) {
    await audit({ actor: "HUMAN", action: "push.unsubscribed", detail: "아침 알림을 껐습니다" });
  }
  return count > 0;
}

export async function subscriptionCount(): Promise<number> {
  return db.pushSubscription.count();
}

// ── 알림 내용 ───────────────────────────────────────────────────────────

export interface DigestCounts {
  /** 오늘 가격을 다시 찍어 올려야 하는 저장함 상품 */
  reminders: number;
  /** 카톡에 정정 공지를 올려야 하는 죽은 링크 */
  corrections: number;
  /** 승인만 누르면 되는 딜 */
  ready: number;
}

export interface DigestPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * 숫자를 알림 한 줄로. 할 일이 없으면 null을 돌려주고, 부르는 쪽은 아무것도 보내지 않는다.
 *
 * 링크는 항상 홈이다. 홈이 곧 "지금 할 일" 화면이라(docs/08 §3.3) 세 종류가 다 거기 있고,
 * 알림을 눌렀는데 일부만 보이는 화면으로 떨어지는 것이 더 나쁘다.
 */
export function digestMessage(counts: DigestCounts): DigestPayload | null {
  const parts: string[] = [];
  if (counts.reminders > 0) parts.push(`기록할 상품 ${counts.reminders}개`);
  if (counts.corrections > 0) parts.push(`정정 공지 ${counts.corrections}건`);
  if (counts.ready > 0) parts.push(`승인 대기 ${counts.ready}건`);
  if (parts.length === 0) return null;

  return {
    title: "오늘 할 일",
    body: parts.join(" · "),
    url: "/",
    tag: "qurator-digest",
  };
}

/** 홈 화면이 세는 것과 **같은 숫자**를 센다 — 알림과 화면이 다르면 알림을 믿지 않게 된다. */
export async function collectDigest(now: Date = new Date()): Promise<DigestCounts> {
  const [crawless, deadLinks, ready] = await Promise.all([
    isCrawlessMode(),
    loadDeadLinkAlerts(),
    // 홈의 "승인 대기" 칸과 같은 조건 — SKIPPED는 approvalStage 자체가 달라 여기 섞이지 않는다.
    db.deal.count({ where: { approvalStage: "READY_TO_PUBLISH" } }),
  ]);
  const reminders = crawless ? (await dueForReminder(now)).length : 0;

  return { reminders, corrections: deadLinks.length, ready };
}

// ── 전송 ────────────────────────────────────────────────────────────────

export interface SendResult {
  sent: number;
  /** 만료·연속 실패로 지운 구독 수 */
  removed: number;
  failed: number;
}

/**
 * 저장된 모든 구독에 같은 알림을 보낸다.
 *
 * 실패를 삼키지 않되 하나가 죽어도 나머지는 보낸다 — 폰을 바꿔 죽은 구독 하나 때문에
 * 살아 있는 폰이 알림을 못 받는 일이 없어야 한다.
 */
export async function sendToAll(payload: DigestPayload): Promise<SendResult> {
  const keys = pushKeys();
  if (!keys) return { sent: 0, removed: 0, failed: 0 };

  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);

  const subs = await db.pushSubscription.findMany();
  const body = JSON.stringify(payload);
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
      result.sent++;
      await db.pushSubscription.update({
        where: { id: sub.id },
        data: { lastOkAt: new Date(), failCount: 0 },
      });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // 404/410 = 푸시 서비스가 "이 구독은 이제 없다"고 확정한 것. 다시 시도할 이유가 없다.
      if (status === 404 || status === 410 || sub.failCount + 1 >= MAX_FAIL) {
        await db.pushSubscription.delete({ where: { id: sub.id } });
        result.removed++;
      } else {
        await db.pushSubscription.update({
          where: { id: sub.id },
          data: { failCount: { increment: 1 } },
        });
        result.failed++;
      }
    }
  }

  return result;
}

// ── 하루 한 통 ──────────────────────────────────────────────────────────

/** KST 기준 오늘 0시. 서버는 UTC로 돌지만 알림을 받는 사람은 한국에 있다. */
export function kstStartOfDay(now: Date): Date {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 9 * 60 * 60 * 1000);
}

/** 오늘 이미 보냈는지. 크론이 두 번 울려도 두 통이 가지 않게 하는 유일한 방어선이다. */
export async function alreadySentToday(now: Date = new Date()): Promise<boolean> {
  const sent = await db.auditLog.findFirst({
    where: { action: DIGEST_ACTION, ts: { gte: kstStartOfDay(now) } },
    select: { id: true },
  });
  return sent !== null;
}

export interface DigestRun {
  status: "sent" | "nothing-to-do" | "already-sent" | "no-subscription" | "not-configured";
  counts: DigestCounts;
  result?: SendResult;
}

/**
 * 아침 알림 한 통. 크론과 설정 탭의 "지금 보내보기" 버튼이 같은 함수를 부른다 —
 * 테스트로 확인한 것과 실제로 가는 것이 같아야 한다.
 *
 * @param force 하루 1회 제한을 건너뛴다(사람이 버튼을 눌렀을 때만).
 */
export async function runDigest(now: Date = new Date(), force = false): Promise<DigestRun> {
  const counts = await collectDigest(now);

  if (!pushKeys()) return { status: "not-configured", counts };
  if (!force && (await alreadySentToday(now))) return { status: "already-sent", counts };

  const payload = digestMessage(counts);
  if (!payload) return { status: "nothing-to-do", counts };

  if ((await subscriptionCount()) === 0) return { status: "no-subscription", counts };

  const result = await sendToAll(payload);

  // 하루 1회 제한을 거는 기록은 **한 대라도 실제로 받았을 때만** 남긴다.
  // 전부 실패한 아침은 알림이 오지 않은 아침이다 — 그걸 "보냈음"으로 적어두면 다시 시도할
  // 길이 막힌다. 성공한 전송은 항상 기록되므로 중복 발송은 여전히 불가능하다.
  await audit({
    actor: "SYSTEM",
    action: result.sent > 0 ? DIGEST_ACTION : "push.digest_failed",
    detail: `${payload.body} → ${result.sent}대 전송${result.removed > 0 ? `, 만료 ${result.removed}건 정리` : ""}`,
    responseCode: result.sent > 0 ? 201 : 500,
  });

  return { status: "sent", counts, result };
}

/**
 * 설정 탭의 "지금 보내보기". 진짜 아침 알림과 **같은 문구**를 보내되, 할 일이 없는 날에도
 * 한 통은 간다 — 버튼을 눌렀는데 아무 일도 안 일어나면 고장인지 할 일이 없는 건지 알 수 없다.
 *
 * 하루 1회 제한을 쓰지도, 소비하지도 않는다(DIGEST_ACTION을 남기지 않는다).
 */
export async function sendTestPush(): Promise<DigestRun> {
  const counts = await collectDigest();
  if (!pushKeys()) return { status: "not-configured", counts };
  if ((await subscriptionCount()) === 0) return { status: "no-subscription", counts };

  const payload = digestMessage(counts) ?? {
    title: "qurator",
    body: "지금은 할 일이 없습니다 — 알림은 잘 옵니다",
    url: "/",
    tag: "qurator-digest",
  };
  const result = await sendToAll(payload);
  await audit({
    actor: "HUMAN",
    action: "push.test",
    detail: `${payload.body} → ${result.sent}대 전송`,
  });

  return { status: "sent", counts, result };
}
