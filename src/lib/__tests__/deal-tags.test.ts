import { describe, expect, it } from "vitest";
import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  formatTagInput,
  parseTagInput,
  parseTags,
  serializeTags,
} from "../deal-tags";

// 태그 하나가 곧 허브의 한 섹션이다. 사람이 아무렇게나 적어도 섹션이 무너지지 않아야 한다.

describe("딜 태그", () => {
  it("쉼표로 나누고 공백을 정리한다", () => {
    expect(parseTagInput(" 가을 아우터 , BF 픽 ")).toEqual(["가을 아우터", "BF 픽"]);
  });

  it("빈 값과 중복을 버린다", () => {
    expect(parseTagInput("겨울,,겨울, ,니트")).toEqual(["겨울", "니트"]);
  });

  it("개수 상한을 넘기지 않는다", () => {
    const parsed = parseTagInput("a,b,c,d,e");
    expect(parsed).toHaveLength(MAX_TAGS);
  });

  it("긴 태그는 잘라 섹션 제목이 한 줄에 들어오게 한다", () => {
    const long = "가".repeat(MAX_TAG_LENGTH + 10);
    expect(parseTagInput(long)[0]).toHaveLength(MAX_TAG_LENGTH);
  });

  it("비어 있으면 null로 저장한다 — '없음'의 형태는 하나뿐이다", () => {
    expect(serializeTags([])).toBeNull();
    expect(serializeTags(["  "])).toBeNull();
  });

  it("저장하고 다시 읽으면 그대로다", () => {
    const tags = ["가을 아우터", "BF 픽"];
    expect(parseTags(serializeTags(tags))).toEqual(tags);
  });

  it("깨진 값이 허브를 죽이지 않는다", () => {
    expect(parseTags("{not json")).toEqual([]);
    expect(parseTags('"문자열"')).toEqual([]);
    expect(parseTags("[1, 2]")).toEqual([]);
    expect(parseTags(null)).toEqual([]);
  });

  it("폼에 다시 넣을 문자열로 되돌린다", () => {
    expect(formatTagInput(["가을 아우터", "BF 픽"])).toBe("가을 아우터, BF 픽");
  });
});
