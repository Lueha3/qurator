"use client";

import { useEffect, useState } from "react";
import { detectInAppBrowser } from "./in-app-browser";
import { noticeCls } from "./form";

// 인앱 브라우저 경고 — docs/03 §7.1·§7.2. 시도하기 **전에** 보여준다.
//
// iOS는 Safari(또는 정식 인증 창구)를 통해서만 Face ID로 패스키를 쓰게 허용한다. 카톡 등
// 인앱 브라우저에서는 뭘 눌러도 NotAllowedError로 막히는데, 그 오류 메시지만으로는
// "이 창 자체가 문제"라는 걸 알아채기 어렵다 — 그래서 버튼을 누르기 전에 먼저 말한다.
//
// 자기 자신의 주소로 된 <a>를 함께 둔다: WKWebView 기반 인앱 브라우저 대부분은 링크를
// 길게 누르면 iOS 자체 컨텍스트 메뉴("Safari에서 열기")가 뜬다 — 앱마다 자체 메뉴 문구가
// 달라도 이 방법은 대체로 통한다.
//
// "use client"라도 첫 렌더는 서버에서 돈다 — 그때는 navigator·window가 없다. useState
// 초기화 함수로 즉시 읽으면 서버는 null(배너 없음), 클라이언트 첫 렌더는 실제 UA로 다른
// 값을 내놓아 하이드레이션 불일치가 난다. 그래서 PushToggle.tsx와 같은 패턴을 쓴다 —
// 초기값은 항상 null로 서버와 맞추고, 마운트 후 이펙트에서 채운다. setState는 마이크로태스크
// 하나 뒤로 미룬다(이펙트 본문에서 곧바로 부르면 린트가 캐스케이딩 렌더로 잡는다).

export function InAppBrowserNotice() {
  const [appName, setAppName] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      setAppName(detectInAppBrowser(navigator.userAgent)?.name ?? null);
      setUrl(window.location.href);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!appName) return null;

  return (
    <div className={noticeCls}>
      <p>
        <b>{appName}</b> 안에서는 Face ID를 쓸 수 없어요.
      </p>
      <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-4">
        <li>⋯ 또는 공유 버튼을 누르고 <b>“Safari로 열기”</b>를 골라주세요.</li>
        {url && (
          <li>
            메뉴가 없으면 아래 주소를 길게 눌러 <b>“Safari에서 열기”</b>를 골라주세요.
            <br />
            <a href={url} className="break-all font-semibold underline">
              {url}
            </a>
          </li>
        )}
      </ol>
    </div>
  );
}
