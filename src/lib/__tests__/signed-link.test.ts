import { beforeAll, describe, expect, it } from "vitest";
import { signCardToken, verifyCardToken } from "../signed-link";

beforeAll(() => {
  process.env.APP_SECRET = "test-secret-that-is-long-enough";
});

const CARD_ID = "11111111-2222-3333-4444-555555555555";

// 복사 웹뷰는 미들웨어 인증의 예외다(텔레그램 인앱 브라우저에 세션이 없다).
// 그 예외를 안전하게 만드는 것이 이 서명이며, 카드 본문에는 커미션 ULID가 들어 있다.

describe("복사 링크 서명", () => {
  it("발급한 토큰은 검증을 통과하고 cardId를 되돌려준다", () => {
    const result = verifyCardToken(signCardToken(CARD_ID));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cardId).toBe(CARD_ID);
  });

  it("만료된 토큰을 거부한다", () => {
    const result = verifyCardToken(signCardToken(CARD_ID, -1000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("expired");
  });

  it("서명을 위조한 토큰을 거부한다", () => {
    const result = verifyCardToken(`${CARD_ID}.${Date.now() + 100000}.forged`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_signature");
  });

  it("만료 시각만 바꿔치기한 토큰을 거부한다", () => {
    const token = signCardToken(CARD_ID);
    const [id, , sig] = token.split(".");
    // 만료를 미래로 늘려도 서명이 payload 전체를 덮으므로 통과하지 못한다
    const tampered = `${id}.${Date.now() + 999_999_999}.${sig}`;
    const result = verifyCardToken(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_signature");
  });

  it("다른 카드 id로 바꿔치기한 토큰을 거부한다", () => {
    const token = signCardToken(CARD_ID);
    const [, exp, sig] = token.split(".");
    const other = "99999999-8888-7777-6666-555555555555";
    const result = verifyCardToken(`${other}.${exp}.${sig}`);
    expect(result.ok).toBe(false);
  });

  it("서명 없는 순수 cardId를 거부한다 (예전 URL 형식 차단)", () => {
    const result = verifyCardToken(CARD_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("다른 시크릿으로 만든 토큰은 통과하지 못한다", () => {
    const token = signCardToken(CARD_ID);
    process.env.APP_SECRET = "a-completely-different-secret-value";
    const result = verifyCardToken(token);
    process.env.APP_SECRET = "test-secret-that-is-long-enough";
    expect(result.ok).toBe(false);
  });

  it("APP_SECRET이 너무 짧으면 서명 발급이 실패한다 (조용히 약한 서명을 쓰지 않는다)", () => {
    const saved = process.env.APP_SECRET;
    process.env.APP_SECRET = "short";
    expect(() => signCardToken(CARD_ID)).toThrow(/APP_SECRET/);
    process.env.APP_SECRET = saved;
  });
});
