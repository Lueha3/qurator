import { db } from "./db";

// Phase 0은 현표 1인 전용이다. creator_id는 스키마 전체에 이미 FK로 걸려 있으므로
// (docs/02-architecture.md §3.1) 나중에 다중 크리에이터로 확장할 때 여기 한 곳만 바뀐다.
const CREATOR_HANDLE = "maison_jenflox";

export async function getDefaultCreator() {
  const existing = await db.creator.findUnique({ where: { handle: CREATOR_HANDLE } });
  if (existing) return existing;
  // 시드를 안 돌린 채로 개발을 시작한 경우를 대비한 방어적 자동 생성.
  return db.creator.create({ data: { handle: CREATOR_HANDLE } });
}
