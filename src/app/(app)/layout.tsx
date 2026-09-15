import { BottomNav } from "@/components/BottomNav";
import { CaptureFab } from "@/components/CaptureFab";

// 작업대(비공개) 레이아웃 — 하단 탭과 캡처 FAB이 모든 탭에 함께 있다.
// 팔로워가 보는 공개 지면(/hub · /l · /expired)은 이 그룹 밖이라 이 껍데기를 쓰지 않는다.

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* 하단 탭(약 3.4rem)과 FAB이 마지막 콘텐츠를 가리지 않도록 그만큼 비워둔다 */}
      <div className="flex flex-1 flex-col pb-[calc(8rem+env(safe-area-inset-bottom,0px))]">
        {children}
      </div>
      <CaptureFab />
      <BottomNav />
    </>
  );
}
