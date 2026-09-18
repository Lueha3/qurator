import { PasskeyLogin } from "@/components/PasskeyLogin";

// 로그인 화면 — 게이트 앞(공개)에 있는 유일한 앱 페이지다(proxy.ts PUBLIC_PATHS).
// 그래서 여기서는 **DB를 읽지 않는다**. 딜도, 숫자도, "패스키가 등록돼 있는지"도 그리지 않는다 —
// 로그인 전 화면이 뭔가를 알려주기 시작하면 그 순간 게이트가 새는 곳이 된다.
//
// 초대 코드는 검사하지 않고 그대로 넘긴다. 유효한지는 라우트가 판정한다 — 이 화면이
// "이 코드는 살아 있다"를 알려주면 코드를 긁는 도구에게 답을 주는 꼴이 된다.
export const metadata = { title: "로그인 · qurator" };

export default async function LoginPage(props: PageProps<"/login">) {
  const { invite } = await props.searchParams;
  const code = typeof invite === "string" ? invite : undefined;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-5 px-6 py-10">
      <div>
        <h1 className="text-lg font-semibold">qurator</h1>
        <p className="mt-1 text-sm text-muted">
          {code
            ? "이 기기를 등록하면, 다음부터는 얼굴만 보면 열립니다."
            : "커미션 링크가 들어 있는 작업 화면이라 잠겨 있습니다."}
        </p>
      </div>

      <PasskeyLogin invite={code} />

      <p className="text-xs leading-relaxed text-muted">
        패스키는 이 기기 안에서만 만들어지고 나가지 않습니다. 아이클라우드 키체인에 저장되므로
        Safari·홈 화면 앱·맥 어디서든 같은 얼굴로 열립니다.
      </p>
    </main>
  );
}
