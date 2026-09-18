// 브랜드 모노그램 — 사진 없이 줄마다 시각적 앵커를 준다 (docs/08 §4.0.6).
//
// 이 앱은 상품 이미지를 저장하지 않는다([03] "이미지 대량 복제 금지", 잡코리아 판례 안전선).
// 그래서 목록이 글자만으로 채워졌고, 그게 스프레드시트처럼 보이는 첫째 이유였다.
// 모노그램은 그 원칙을 건드리지 않는다 — 글자 한 자와 색뿐이다.
//
// 색은 브랜드 이름의 해시로 정한다. 같은 브랜드는 언제나 같은 색이라 눈이 익고,
// 서버와 클라이언트가 같은 순수 계산을 하므로 하이드레이션이 흔들리지 않는다.
//
// 처음엔 djb2 % 8을 썼는데 전부 초록으로 나왔다: 곱수 33 ≡ 1 (mod 8)이라 결국 코드포인트
// 합의 하위 3비트만 남고, 한글 음절은 그 비트가 구조적으로 몇 값에 몰린다. 그래서 FNV-1a에
// 아발란체를 한 번 더 돌리고 **상위 3비트**를 쓴다 — 실제 브랜드 20개로 8칸 고른 분포를 확인했다.

function paletteIndex(brand: string): number {
  let h = 0x811c9dc5;
  for (const ch of brand) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 29; // 0..7
}

export function BrandMark({ brand, size = "md" }: { brand: string; size?: "md" | "lg" }) {
  const i = paletteIndex(brand);
  const glyph = [...brand.trim()][0] ?? "?";
  const dim = size === "lg" ? "h-12 w-12 rounded-2xl text-lg" : "h-10 w-10 rounded-xl text-[15px]";

  return (
    <div
      aria-hidden
      className={`flex ${dim} shrink-0 select-none items-center justify-center font-semibold`}
      style={{ background: `var(--mark-${i}-bg)`, color: `var(--mark-${i}-ink)` }}
    >
      {glyph}
    </div>
  );
}
