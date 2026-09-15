import { redirect } from "next/navigation";

// /watch는 딜 탭의 "저장함" 필터로 합쳐졌다 (docs/08 §2.2 G6).
// 폰 홈 화면·북마크에 남아 있을 수 있어 주소는 살려두고 넘긴다.
export default function WatchRedirect() {
  redirect("/deals?f=saved");
}
