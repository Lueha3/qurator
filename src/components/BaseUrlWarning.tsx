import { headers } from "next/headers";

// 공개 주소 설정이 실제 주소와 다를 때의 경고 — docs/03 §7.1.
//
// 이 값이 틀리면 **Face ID 로그인이 전부 막히고**(패스키는 도메인에 묶인다) 등록 초대 링크도
// 엉뚱한 주소로 나간다. 그런데 증상은 "버튼을 눌렀는데 안 된다"뿐이라 원인을 짐작하기 어렵다 —
// 그래서 눌러보기 전에 여기서 상시로 알린다.
//
// 팔로워가 받는 링크는 이 값과 무관하다(2026-09-18 확인): 카톡 카드는 무신사 원본 링크를 그대로
// 싣고, 허브는 상대경로(`/l/...`)를 쓴다. 한때 이 경고가 "카톡 링크가 이 값으로 만들어진다"고
// 적혀 있었는데 사실이 아니었다 — 호출부가 없는 `shortLinkUrl()`을 보고 잘못 판단한 것이다.
//
// 요청 헤더의 host를 쓰는데, 이건 **경고용이지 판단용이 아니다**(헤더는 클라이언트가 바꿀 수 있다).
// 패스키의 rpID는 여전히 PUBLIC_BASE_URL 하나에서만 나온다.

export async function BaseUrlWarning() {
  const configured = process.env.PUBLIC_BASE_URL;
  const host = (await headers()).get("host");
  if (!host) return null;

  if (!configured) {
    return (
      <Banner>
        <b>PUBLIC_BASE_URL이 설정되지 않았습니다.</b> Face ID 로그인과 기기 등록 초대가 동작하지
        않습니다. Vercel 환경변수에 <Code>https://{host}</Code>를 넣어주세요.
      </Banner>
    );
  }

  let configuredHost: string;
  try {
    configuredHost = new URL(configured).host;
  } catch {
    return (
      <Banner>
        <b>PUBLIC_BASE_URL 형식이 잘못됐습니다</b> (<Code>{configured}</Code>).{" "}
        <Code>https://{host}</Code> 형태로 넣어주세요.
      </Banner>
    );
  }

  if (configuredHost === host) return null;

  return (
    <Banner>
      <b>공개 주소 설정이 지금 주소와 다릅니다.</b>
      <br />
      설정값 <Code>{configuredHost}</Code> · 지금 주소 <Code>{host}</Code>
      <br />
      <span className="mt-1 block">
        패스키는 도메인에 묶입니다 — 이 값이 다르면 <b>Face ID 등록·로그인이 전부 실패</b>하고,
        기기 등록 초대 링크도 설정값 주소로 나갑니다.
        <br />
        팔로워가 받는 링크(카톡·허브)는 이 값과 무관하니 걱정하지 않으셔도 됩니다.
      </span>
      <span className="mt-1 block">
        Vercel 환경변수를 <Code>https://{host}</Code>로 바꾸고 재배포해주세요.
      </span>
    </Banner>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm leading-relaxed text-danger">
      ⚠️ {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono break-all">{children}</code>;
}
