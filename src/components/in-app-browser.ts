// 인앱 브라우저 감지 — docs/03 §7.1.
//
// 카카오톡·인스타그램 같은 앱은 링크를 자기 앱 안의 웹뷰로 띄운다. iOS는 **Safari(또는 정식
// 인증 창구)를 통해서만** Face ID로 패스키를 쓰게 허용한다 — 인앱 브라우저에는 그 권한 자체가
// 없다. 그래서 뭘 눌러도 `NotAllowedError`로 조용히 막히고, 사람 눈에는 "그냥 안 됨"으로만
// 보여 원인을 짐작할 수 없다.
//
// 특히 이 위험이 큰 지점은 **초대 링크가 카톡으로 배달된다는 것**이다(docs/03 §7.2). 등록시킬
// 사람이 카톡 안에서 그 링크를 그대로 누르면 100% 이 벽에 부딪힌다 — 그래서 시도하기 **전에**
// 감지해서 "Safari로 열어주세요"를 먼저 보여준다.

export interface InAppBrowser {
  name: string;
}

const SIGNATURES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /KAKAOTALK/i, name: "카카오톡" },
  { pattern: /Instagram/i, name: "인스타그램" },
  { pattern: /FBAN|FBAV|FB_IAB/i, name: "페이스북" },
  { pattern: /\bLine\//i, name: "라인" },
  { pattern: /NAVER\(/i, name: "네이버 앱" },
  { pattern: /Threads/i, name: "스레드" },
  { pattern: /DaumApps|DaumDevice/i, name: "다음 앱" },
];

export function detectInAppBrowser(userAgent: string | undefined | null): InAppBrowser | null {
  if (!userAgent) return null;
  for (const { pattern, name } of SIGNATURES) {
    if (pattern.test(userAgent)) return { name };
  }
  return null;
}
