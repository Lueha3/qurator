// 아이콘 — 라이브러리를 들이지 않고 필요한 다섯 개만 직접 그린다.
// 규격: 20×20, 1.75 선굵기, currentColor. 채우지 않는다(선만) — 하단 탭에서 글자와 같은 무게로 읽힌다.
//
// 이모지를 쓰지 않는 이유: 기기마다 다른 그림이 나오고(안드로이드·iOS·윈도우가 전부 다르다),
// 크기·정렬이 제각각이라 줄이 흔들린다. 딜 카드의 버튼 문구에 들어간 이모지는 docs/06 §3.0이
// 정한 문구의 일부라 그대로 두고, **구조(탭·FAB)만** 선 아이콘으로 바꾼다.

interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-5 w-5"}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 8.2 10 3l6.5 5.2" />
      <path d="M5 7.8V16a.5.5 0 0 0 .5.5h3v-4h3v4h3a.5.5 0 0 0 .5-.5V7.8" />
    </Svg>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.75" y="4" width="14.5" height="5" rx="1.5" />
      <rect x="2.75" y="11" width="14.5" height="5" rx="1.5" />
    </Svg>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 16.5h14" />
      <path d="M5.5 16.5v-5" />
      <path d="M10 16.5V4.5" />
      <path d="M14.5 16.5v-8" />
    </Svg>
  );
}

/**
 * 설정 — 톱니바퀴가 아니라 슬라이더다. 22px에서 톱니는 뭉개져 햇살처럼 읽히는데(실기기 확인),
 * 가로줄 두 개와 손잡이는 그 크기에서도 모양이 살아 있다.
 */
export function SlidersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6.5h14M3 13.5h14" />
      <circle cx="7.5" cy="6.5" r="2" />
      <circle cx="12.5" cy="13.5" r="2" />
    </Svg>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.75 7.5a1.5 1.5 0 0 1 1.5-1.5h1.6l1-1.75h6.3l1 1.75h1.6a1.5 1.5 0 0 1 1.5 1.5v6.75a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z" />
      <circle cx="10" cy="10.6" r="2.8" />
    </Svg>
  );
}
