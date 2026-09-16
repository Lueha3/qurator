// VAPID 키 한 쌍을 만든다 — 아침 알림(docs/08 §4.0.5)이 "우리가 보낸 것"임을 푸시 서비스에
// 증명하는 열쇠다. `npm run push:keys`.
//
// 한 번 만들면 바꾸지 않는다. 키를 바꾸면 **기존 구독이 전부 무효**가 되어 폰에서 알림을
// 다시 켜야 한다.
//
// 출력된 개인키는 Vercel 환경변수에만 넣는다. 저장소·문서·화면 어디에도 적지 않는다
// (APP_ACCESS_TOKEN과 같은 취급).

import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
Vercel → Settings → Environment Variables 에 그대로 넣으세요 (Production·Preview 모두):

  VAPID_PUBLIC_KEY   ${publicKey}
  VAPID_PRIVATE_KEY  ${privateKey}
  VAPID_SUBJECT      mailto:<연락 가능한 메일 주소>

개인키는 여기 말고 어디에도 남기지 마세요. 키를 바꾸면 폰에서 알림을 다시 켜야 합니다.
`);
