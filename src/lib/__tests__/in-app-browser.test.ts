import { describe, expect, it } from "vitest";
import { detectInAppBrowser } from "../../components/in-app-browser";

// 인앱 브라우저 감지 — docs/03 §7.1·§7.2.
//
// 이 판정이 값어치가 있는 건 카톡에서 실제로 이 벽에 부딪힌 뒤부터다: 등록 초대 링크가
// 카톡으로 배달되므로(§7.2), 여기서 놓치면 그 사람은 "눌렀는데 안 됨"만 보고 만다.

const IOS_KAKAO =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 KAKAOTALK 10.9.5";
const ANDROID_KAKAO =
  "Mozilla/5.0 (Linux; Android 13; SM-S911N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 KAKAOTALK 11.2.1";
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("인앱 브라우저 감지", () => {
  it("카카오톡(iOS)을 알아본다 — 초대 링크가 카톡으로 배달되는 실제 경로다", () => {
    expect(detectInAppBrowser(IOS_KAKAO)).toEqual({ name: "카카오톡" });
  });

  it("카카오톡(안드로이드)도 알아본다", () => {
    expect(detectInAppBrowser(ANDROID_KAKAO)?.name).toBe("카카오톡");
  });

  it("인스타그램·라인·네이버 앱도 알아본다", () => {
    expect(detectInAppBrowser("... Instagram 300.0.0 ...")?.name).toBe("인스타그램");
    expect(detectInAppBrowser("... Line/13.0.0 ...")?.name).toBe("라인");
    expect(detectInAppBrowser("... NAVER(inapp; search; 1200; 12.0.0) ...")?.name).toBe("네이버 앱");
  });

  it("진짜 Safari는 걸리지 않는다 — 오탐이 나면 진짜 Safari 사용자까지 겁준다", () => {
    expect(detectInAppBrowser(SAFARI)).toBeNull();
  });

  it("값이 없거나 빈 문자열도 안전하게 처리한다", () => {
    expect(detectInAppBrowser(null)).toBeNull();
    expect(detectInAppBrowser(undefined)).toBeNull();
    expect(detectInAppBrowser("")).toBeNull();
  });
});
