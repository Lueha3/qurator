// 게이트웨이 운영 CLI — docs/03-account-safety.md §6.2·6.3의 복구 런북을 사람이 실행하는 수단.
//
// 설계상 차단(BLOCKED)은 **자동으로 풀리지 않는다**. 자동 재개는 "차단을 뚫으려는 재시도"가 되어
// 여기어때 판례가 준 안전선(보호조치 우회 없음)에서 벗어나기 때문이다.
// 그래서 해제는 반드시 사람의 명시적 명령이어야 하고, 이 스크립트가 그 유일한 경로다.
//
//   npm run gateway status          현재 서킷·킬스위치·오늘 사용량
//   npm run gateway resume <host>   차단 해제 (계정 상태를 눈으로 확인한 뒤에만)
//   npm run gateway kill            글로벌 킬 스위치 ON — 모든 아웃바운드 즉시 중단
//   npm run gateway unkill          킬 스위치 OFF

import { db } from "../src/lib/db";
import { resumeHost } from "../src/lib/fetch-gateway";
import { getLimits, isKillSwitchOn, setKillSwitch } from "../src/lib/policy";
import { audit } from "../src/lib/audit";

async function status() {
  const [circuits, killed, limits] = await Promise.all([
    db.circuitState.findMany(),
    isKillSwitchOn(),
    getLimits(),
  ]);

  const since = new Date(Date.now() - 24 * 3_600_000);
  const used = await db.fetchLog.count({
    where: {
      ts: { gte: since },
      outcome: { notIn: ["BLOCKED_POLICY", "BLOCKED_ROBOTS", "BLOCKED_BUDGET", "BLOCKED_CIRCUIT"] },
    },
  });

  console.log(`킬 스위치: ${killed ? "🔴 ON — 모든 아웃바운드 중단됨" : "🟢 off"}`);
  console.log(`24시간 사용량: ${used} / ${limits.dailyMax}`);
  console.log("\n서킷 상태:");
  if (circuits.length === 0) {
    console.log("  (기록 없음 — 아직 아무 요청도 나가지 않았습니다)");
  }
  for (const c of circuits) {
    const icon = c.state === "HEALTHY" ? "🟢" : c.state === "DEGRADED" ? "🟡" : "🔴";
    const until = c.pausedUntil ? ` (${c.pausedUntil.toISOString()}까지)` : "";
    console.log(`  ${icon} ${c.host}: ${c.state}${until}`);
    if (c.reason) console.log(`      사유: ${c.reason}`);
    if (c.state === "BLOCKED") {
      console.log(`      해제: npm run gateway resume ${c.host}`);
      console.log("      ⚠️ 해제 전에 무신사에서 계정 상태(경고·제한 알림)를 직접 확인하세요.");
    }
  }

  const recent = await db.fetchLog.findMany({ orderBy: { ts: "desc" }, take: 10 });
  if (recent.length > 0) {
    console.log("\n최근 요청 10건:");
    for (const r of recent) {
      console.log(
        `  ${r.ts.toISOString()} ${r.outcome.padEnd(16)} ${r.responseCode ?? "-"} ${r.url}`
      );
    }
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case "status":
      await status();
      break;

    case "resume": {
      if (!arg) {
        console.error("호스트를 지정하세요: npm run gateway resume www.musinsa.com");
        process.exit(1);
      }
      await resumeHost(arg);
      await audit({
        actor: "HUMAN",
        action: "gateway.resumed",
        detail: `${arg} 서킷을 사람이 해제 (CLI)`,
      });
      console.log(`✅ ${arg} 서킷을 해제했습니다. 첫 요청부터 정상 페이싱으로 나갑니다.`);
      break;
    }

    case "kill":
      await setKillSwitch(true, "CLI에서 수동 활성화");
      await audit({ actor: "HUMAN", action: "gateway.killswitch_on", detail: "CLI" });
      console.log("🔴 킬 스위치 ON — 모든 아웃바운드 요청이 즉시 거부됩니다.");
      break;

    case "unkill":
      await setKillSwitch(false, "CLI에서 수동 해제");
      await audit({ actor: "HUMAN", action: "gateway.killswitch_off", detail: "CLI" });
      console.log("🟢 킬 스위치 off.");
      break;

    default:
      console.log("사용법: npm run gateway <status|resume <host>|kill|unkill>");
      process.exit(1);
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
