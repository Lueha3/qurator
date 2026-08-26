// robots.txt 파서 — docs/03-account-safety.md §4.2: "robots.txt Disallow 무조건 제외".
//
// 우리는 차단을 우회하지 않는다(§9 Never List 7번). robots.txt 준수는 그 원칙의 최소 실천이며,
// 여기어때 판례가 말하는 "보호조치를 우회하지 않은 상태"를 유지하는 근거이기도 하다.
//
// 표준(RFC 9309)의 실무적 부분집합을 구현한다:
//   - User-agent 그룹핑, 구체적 UA가 '*'보다 우선
//   - 경로 매칭은 접두사 기준, 와일드카드 '*'와 종료 앵커 '$' 지원
//   - 같은 경로에 Allow와 Disallow가 모두 매치되면 더 긴 규칙이 이기고, 길이가 같으면 Allow가 이긴다

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  /** UA 그룹별 규칙. 키는 소문자 UA 토큰 */
  groups: Map<string, Rule[]>;
}

export function parseRobots(text: string): RobotsRules {
  const groups = new Map<string, Rule[]>();
  let currentAgents: string[] = [];
  // 연속된 User-agent 줄은 하나의 그룹을 공유한다. 규칙 줄이 나온 뒤의 User-agent는 새 그룹을 연다.
  let sawRuleSinceAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (sawRuleSinceAgent) {
        currentAgents = [];
        sawRuleSinceAgent = false;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      continue;
    }

    if (field === "allow" || field === "disallow") {
      sawRuleSinceAgent = true;
      // User-agent 없이 등장한 규칙은 무시한다(표준상 소속 그룹이 없음).
      if (currentAgents.length === 0) continue;
      // 빈 Disallow는 "전체 허용"을 뜻하므로 규칙으로 추가하지 않는다.
      if (field === "disallow" && value === "") continue;
      for (const agent of currentAgents) {
        groups.get(agent)!.push({ allow: field === "allow", pattern: value });
      }
    }
  }

  return { groups };
}

/** robots 경로 패턴('*'와 '$' 지원)이 주어진 경로에 매치되는지. 매치 길이를 반환(미매치는 -1). */
function matchLength(pattern: string, path: string): number {
  if (pattern === "") return -1;
  const hasAnchor = pattern.endsWith("$");
  const body = hasAnchor ? pattern.slice(0, -1) : pattern;

  if (!body.includes("*")) {
    if (hasAnchor) return path === body ? body.length : -1;
    return path.startsWith(body) ? body.length : -1;
  }

  // 와일드카드를 정규식으로 — 특수문자는 이스케이프하고 '*'만 .*로 바꾼다.
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}${hasAnchor ? "$" : ""}`);
  return re.test(path) ? body.length : -1;
}

/**
 * robots.txt 조회 결과에 따른 판정 (RFC 9309 §2.3.1).
 * 이 함수가 존재하는 이유: "못 가져왔으니 그냥 진행"이 표준 위반이기 때문이다.
 *   - 2xx: 파싱해서 규칙 적용
 *   - 4xx: 규칙 없음 → 전면 허용 (MAY)
 *   - 5xx·네트워크 실패: 전면 **금지** (MUST) ← 직관과 반대라 실수하기 쉬운 지점
 */
export type RobotsFetchOutcome =
  | { kind: "parsed"; rules: RobotsRules }
  | { kind: "absent" } // 4xx — robots.txt가 없다 → 허용
  | { kind: "unavailable" }; // 5xx/네트워크 실패 → 금지

export function decideByOutcome(
  outcome: RobotsFetchOutcome,
  userAgent: string,
  pathWithQuery: string
): boolean {
  if (outcome.kind === "absent") return true;
  if (outcome.kind === "unavailable") return false;
  return isAllowed(outcome.rules, userAgent, pathWithQuery);
}

/** UA 문자열에서 robots 매칭에 쓰는 제품 토큰을 뽑는다 ("HoneyFlowBot/1.0 (+...)" → "honeyflowbot") */
export function productToken(userAgent: string): string {
  return userAgent.trim().split("/")[0].split(/\s/)[0].toLowerCase();
}

/**
 * 이 UA로 이 경로를 가져와도 되는가.
 * `pathWithQuery`에는 반드시 쿼리스트링까지 넘겨야 한다 — RFC 9309는 경로 매칭에 쿼리를 포함하며,
 * pathname만 넘기면 `Disallow: /*?` 계열 규칙을 통째로 놓친다.
 */
export function isAllowed(rules: RobotsRules, userAgent: string, pathWithQuery: string): boolean {
  const token = productToken(userAgent);
  const path = pathWithQuery;

  // 가장 구체적인 매치: 우리 제품 토큰에 대한 접두사 매치 중 가장 긴 것. 없으면 '*'.
  // (includes()로 하면 robots.txt의 짧은 토큰 'bot' 같은 그룹에 잘못 편입된다.)
  let bestAgent: string | null = null;
  for (const agent of rules.groups.keys()) {
    if (agent === "*") continue;
    if (token.startsWith(agent) && (bestAgent === null || agent.length > bestAgent.length)) {
      bestAgent = agent;
    }
  }
  const applicable = rules.groups.get(bestAgent ?? "*") ?? [];
  if (applicable.length === 0) return true;

  let best: { allow: boolean; len: number } | null = null;
  for (const rule of applicable) {
    const len = matchLength(rule.pattern, path);
    if (len < 0) continue;
    if (
      best === null ||
      len > best.len ||
      // 길이가 같으면 Allow 우선 (RFC 9309)
      (len === best.len && rule.allow && !best.allow)
    ) {
      best = { allow: rule.allow, len };
    }
  }
  return best ? best.allow : true;
}
