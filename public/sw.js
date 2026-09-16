// qurator 서비스워커 — **푸시 전용**.
//
// docs/08 §4.2-3은 서비스워커를 넣지 않기로 했었다. 이유는 오프라인 지원이 목표가 아닌데
// 캐시가 구버전 화면을 붙들고 있는 사고가 이득보다 크다는 것이었다. 그 판단은 지금도 유효하다 —
// 그래서 이 워커에는 **fetch 핸들러가 없다**. 화면 요청은 이 파일을 지나가지 않으므로
// 캐시가 구버전을 붙들 수 있는 코드 자체가 존재하지 않는다(브라우저도 fetch 핸들러가 없는
// 워커는 내비게이션에서 아예 건너뛴다).
//
// 웹 푸시는 서비스워커 없이는 불가능하다 — push 이벤트를 받을 곳이 여기뿐이다. 그래서
// "푸시를 받는 데 필요한 최소한"만 둔다. 여기에 캐시 코드를 추가하지 말 것.

self.addEventListener("install", () => {
  // 새 워커가 기존 워커의 종료를 기다리지 않게 한다 — 알림 문구를 고쳤는데
  // 폰에서 다음 방문까지 옛 워커가 남아 있는 상황을 막는다.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // 본문이 없거나 깨져도 알림은 떠야 한다 — 조용히 사라지면 사람은 "푸시가 고장났다"고만 안다.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "qurator";
  const options = {
    body: payload.body || "확인할 것이 있습니다",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // 같은 태그면 새 알림이 이전 것을 덮어쓴다 — 아침 알림이 며칠치 쌓이지 않게.
    tag: payload.tag || "qurator-digest",
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // 이미 앱이 열려 있으면 새 창을 만들지 않고 그 창을 앞으로 가져온다.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
