import { PasskeyLogin } from "@/components/PasskeyLogin";

// 로그인 화면 — 게이트 앞(공개)에 있는 유일한 앱 페이지다(proxy.ts PUBLIC_PATHS).
// 그래서 여기서는 **DB를 읽지 않는다**. 딜도, 숫자도, "패스키가 등록돼 있는지"도 그리지 않는다 —
// 로그인 전 화면이 뭔가를 알려주기 시작하면 그 순간 게이트가 새는 곳이 된다.
//
// 초대 코드는 검사하지 않고 그대로 넘긴다. 유효한지는 라우트가 판정한다 — 이 화면이
// "이 코드는 살아 있다"를 알려주면 코드를 긁는 도구에게 답을 주는 꼴이 된다.
//
// 모양은 GrowthPilot의 첫 화면(SetupCard)과 같다: 가운데 카드 하나, 손 흔드는 이모지, 제목 한 줄, 설명 한 문단.
export const metadata = { title: "로그인 · qurator" };

export default async function LoginPage(props: PageProps<"/login">) {
  const { invite, next } = await props.searchParams;
  const code = typeof invite === "string" ? invite : undefined;
  const nextPath = typeof next === "string" ? next : undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="card w-full max-w-sm p-7 shadow-sm">
        <p className="text-3xl" aria-hidden>
          {code ? "👋" : "🔒"}
        </p>
        <h1 className="mt-4 text-xl font-bold">{code ? "이 폰을 등록할게요" : "Face ID로 열어주세요"}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {code
            ? "한 번만 등록해두면, 다음부터는 Face ID로 바로 들어와요."
            : "처음이면 관리자에게 받은 등록 링크로 먼저 등록해주세요. 홈 화면 앱은 처음 한 번만 다시 들어와요."}
        </p>

        <div className="mt-6">
          <PasskeyLogin invite={code} next={nextPath} />
        </div>

        <p className="mt-5 text-xs leading-relaxed text-ink-faint">얼굴 정보는 폰 밖으로 나가지 않아요.</p>
      </div>
    </main>
  );
}
