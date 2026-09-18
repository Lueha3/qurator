import { headers } from "next/headers";

// 공개 주소 설정이 실제 주소와 다를 때의 경고 — docs/03 §7.1.
//
// `PUBLIC_BASE_URL`은 패스키 도메인만 정하는 값이 아니다. **카톡에 나가는 숏링크**(`/l/...`)도
// 이 값으로 만든다. 패스키는 등록 버튼을 눌러야 틀린 걸 알지만, 숏링크는 **조용히 잘못 나간다** —
// 그리고 카톡은 이미 보낸 메시지를 고칠 수 없다. 그래서 여기서 상시로 알린다.
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
        <b>PUBLIC_BASE_URL이 설정되지 않았습니다.</b> 카톡 숏링크가 만들어지지 않고 Face ID
        로그인도 동작하지 않습니다. Vercel 환경변수에 <Code>https://{host}</Code>를 넣어주세요.
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
        이 값으로 <b>카톡에 나가는 링크</b>가 만들어집니다. 지금 상태로 발행하면 팔로워가 받는 링크가
        설정값 주소로 나가고, 그 주소가 사라지면 <b>이미 보낸 카톡의 링크가 전부 죽습니다</b>. Face ID
        등록도 이것 때문에 실패합니다.
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
