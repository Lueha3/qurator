import type { MetadataRoute } from "next";

// PWA 매니페스트 — docs/08 §3.3 V2-A. 폰 홈 화면에 추가했을 때 브라우저 UI 없이 앱처럼 열리게 한다.
//
// 서비스워커는 두지 않는다(docs/08 §4.2-3): 오프라인 지원이 목표가 아니고, 캐시가 구버전 화면을
// 붙들고 있는 사고가 이득보다 크다. manifest만으로 standalone·아이콘·테마색이 전부 해결된다.
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
