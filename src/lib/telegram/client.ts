// 텔레그램 Bot API 얇은 클라이언트.
//
// SDK(grammY/telegraf)를 쓰지 않는 이유: Bot API는 단순 HTTPS POST JSON이고,
// SDK의 미들웨어·수명주기가 Next.js route handler 환경에서 오히려 방해가 된다.
// 더 중요하게는 **텔레그램으로 나가는 HTTP는 무신사 Fetch Gateway와 완전히 분리된 경로**여야 하는데,
// 자체 구현이 그 경계를 코드로 명확하게 만든다.
//
// 텔레그램은 현표의 밥줄 계정(카카오/무신사/Meta)과 무관한 별도 채널이라 계정 리스크가 0이다.
// 그래서 이 경로는 게이트웨이를 통과하지 않는다 — 통과시키면 무신사용 레이트리밋이
// 승인 UI를 느리게 만들어 오히려 해롭다.

/* eslint-disable no-restricted-globals -- 텔레그램 API는 무신사 게이트웨이와 무관한 별도 경로다 */

const API_BASE = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly description: string,
    readonly errorCode?: number
  ) {
    super(`${method}: ${description}`);
    this.name = "TelegramError";
  }
}

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.");
  return t;
}

export async function callMethod<T = unknown>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });

  const json = (await response.json()) as
    | { ok: true; result: T }
    | { ok: false; description: string; error_code?: number };

  if (!json.ok) {
    throw new TelegramError(method, json.description, json.error_code);
  }
  return json.result;
}

// ── HTML 이스케이프 ─────────────────────────────────────────────────────
// parse_mode는 'HTML'로 고정한다. MarkdownV2는 18개 특수문자를 전부 이스케이프해야 하고,
// 가격 문자열 하나("89,000원 → 53,400원 (40%)")에도 이스케이프 대상이 여럿 섞여
// 하나만 빠지면 메시지가 400으로 통째로 유실된다. HTML은 3문자만 처리하면 된다.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 태그드 템플릿: 정적 태그는 그대로 두고 **보간값만** 이스케이프한다.
 * 사용: html`<b>${brand}</b> ${name}` — brand/name에 <, & 가 있어도 안전하다.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => {
    if (i === 0) return str;
    return acc + escapeHtml(String(values[i - 1] ?? "")) + str;
  }, "");
}

// ── 메시지 전송 ─────────────────────────────────────────────────────────

export interface InlineButton {
  text: string;
  /** ASCII만, UTF-8 기준 64바이트 한도 */
  callback_data?: string;
  url?: string;
  /** Bot API 7.11+ — 누르면 클라이언트가 클립보드에 복사 (1~256자) */
  copy_text?: { text: string };
}

export type InlineKeyboard = InlineButton[][];

/** callback_data 한도(64바이트)를 넘지 않는지 확인 — 넘으면 텔레그램이 400을 낸다 */
export function assertCallbackDataFits(data: string) {
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > 64) {
    throw new Error(`callback_data가 64바이트를 초과합니다 (${bytes}): ${data}`);
  }
}

/** copy_text 버튼 한도(256자). 초과하면 붙이지 않는 것이 맞다 — 400으로 메시지 전체가 실패한다. */
export const COPY_TEXT_LIMIT = 256;

/** sendMessage text 한도 (엔티티 파싱 후 기준) */
export const MESSAGE_TEXT_LIMIT = 4096;

interface SendOptions {
  chatId: string | number;
  text: string;
  keyboard?: InlineKeyboard;
}

/**
 * 메시지를 보낸다.
 *
 * link_preview_options.is_disabled를 **항상** 켠다. 이유는 편의가 아니라 계정 안전이다:
 * 메시지에 URL이 평문으로 들어가면 텔레그램 서버가 프리뷰 생성을 위해 그 URL을 자체적으로 fetch한다.
 * 큐레이터 링크가 그렇게 방문되면 우리 Fetch Gateway를 우회해 현표 실적에 클릭이 찍힐 수 있다
 * (docs/03 §5.4 불변식이 노리는 바로 그 사고). 프리뷰를 끄는 것이 그 경로를 막는다.
 */
export async function sendMessage(opts: SendOptions): Promise<{ message_id: number }> {
  for (const row of opts.keyboard ?? []) {
    for (const btn of row) {
      if (btn.callback_data) assertCallbackDataFits(btn.callback_data);
    }
  }
  return callMethod<{ message_id: number }>("sendMessage", {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
  });
}

/**
 * 기존 메시지를 제자리에서 갱신한다 (카드 1장의 상태 전이).
 *
 * 주의 두 가지:
 *  - reply_markup을 생략하면 인라인 키보드가 조용히 사라진다 → 항상 명시적으로 함께 보낸다.
 *  - 내용이 완전히 동일하면 텔레그램이 "message is not modified" 400을 낸다.
 *    더블탭·재시도에서 정상적으로 발생하므로 예외로 터뜨리지 않고 성공으로 간주한다.
 */
export async function editMessage(opts: {
  chatId: string | number;
  messageId: number;
  text: string;
  keyboard?: InlineKeyboard;
}): Promise<void> {
  for (const row of opts.keyboard ?? []) {
    for (const btn of row) {
      if (btn.callback_data) assertCallbackDataFits(btn.callback_data);
    }
  }
  try {
    await callMethod("editMessageText", {
      chat_id: opts.chatId,
      message_id: opts.messageId,
      text: opts.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: opts.keyboard ?? [] },
    });
  } catch (err) {
    if (err instanceof TelegramError && err.description.includes("message is not modified")) {
      return; // 정상 — 같은 내용으로 다시 그린 것뿐
    }
    throw err;
  }
}

/**
 * 버튼 탭에 응답한다. **핸들러 진입 즉시, 무거운 작업 전에** 호출해야 한다.
 * 콜백 쿼리 ID는 10~15초 만에 만료되고, 그 사이 사용자 화면에는 스피너가 계속 돈다.
 * 무신사 fetch(최소 간격 5초+지터)나 LLM 호출 뒤에 부르면 십중팔구 만료된다.
 */
export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await callMethod("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  } catch {
    // 만료된 콜백에 답하는 것은 실패해도 무해하다 — 사용자 흐름을 막지 않는다.
  }
}
