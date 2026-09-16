import type { MetadataRoute } from "next";

// PWA 매니페스트 — docs/08 §3.3 V2-A. 폰 홈 화면에 추가했을 때 브라우저 UI 없이 앱처럼 열리게 한다.
//
// manifest만으로 standalone·아이콘·테마색이 전부 해결된다.
//
// 서비스워커(public/sw.js)는 V2-G에서 **푸시 전용으로만** 생겼다(docs/08 §4.0.5) — 웹 푸시는
// 서비스워커 없이 불가능하기 때문이다. 거기에 `fetch` 핸들러는 없다: 캐시가 구버전 화면을
// 붙들고 있는 사고를 막겠다는 원래 판단은 그대로라서, 화면 요청은 워커를 지나가지 않는다.
//
// iOS는 이 파일이 아니라 layout.tsx의 appleWebApp 메타와 apple-icon.png를 본다 — 둘 다 있어야 한다.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "qurator",
    short_name: "qurator",
    description: "무신사 스크린샷을 올리면 가격을 기록하고 채널별 완성 카드를 만드는 큐레이터 작업대",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#faf9f6",
    theme_color: "#c77800",
    lang: "ko",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
