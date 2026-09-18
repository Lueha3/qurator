import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "qurator",
  description: "무신사 스크린샷을 올리면 가격을 기록하고 고지문 포함 채널별 완성 카드를 만드는 워크스페이스",
  // iOS는 manifest.ts의 display:standalone을 보지 않는다 — 홈 화면에서 앱처럼 열리려면 이쪽이 필요하다.
  appleWebApp: { capable: true, title: "qurator", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 노치·홈 인디케이터 영역까지 배경을 채우고, 여백은 env(safe-area-inset-*)로 각자 준다.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f6f1" },
    { media: "(prefers-color-scheme: dark)", color: "#17130f" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ko"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
