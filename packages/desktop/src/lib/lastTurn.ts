/**
 * 마지막 활동 시각을 **사람이 읽는 말**로 바꾼다(`#176`).
 *
 * ## 왜 `AgentsSettings.tsx` 에서 여기로 나왔나
 *
 * `docs/desktop-agent-cards.pdf` 2쪽이 이 값을 **카드에도** 올렸다(`활동  11분 전`).
 * 그때까지 읽는 곳은 상세(`AgentsSettings`)와 프로필(`Profile`) 둘이었고 둘 다 그 파일에서
 * 가져다 썼는데, 카드를 그리는 `settings/AgentGrid.tsx` 는 그럴 수 없다 —
 * `AgentsSettings` 가 `AgentGrid` 를 import 하므로 **순환**이 된다.
 *
 * 순환을 무릅쓰는 것과 계산을 한 벌 더 적는 것 둘 다 답이 아니다. `faceState`·
 * `relaunchGate`·`runnerVersions` 가 같은 자리에서 같은 답을 냈다: **읽는 곳이 둘 이상인
 * 순수 함수는 `lib/` 에 둔다.** 그 세 모듈의 주석이 전부 이유를 같게 적어 뒀다 — 두 벌이
 * 되면 한쪽만 고치는 순간 두 화면이 같은 값을 다르게 말하고, 그 어긋남은 조용하다.
 *
 * ## 접두를 함수 밖으로 뺀 이유 — 라벨이 자리마다 다르다
 *
 * 상세·프로필은 `마지막 활동: 11분 전` 한 덩어리를 쓴다(라벨이 따로 없거나 `Row` 가
 * 붙인다). 카드는 다르다 — 목업이 `활동` 이라는 라벨을 **왼쪽 칸에 이미 세워 뒀고**,
 * 값 칸에 `마지막 활동: 11분 전` 을 넣으면 `활동  마지막 활동: 11분 전` 이 된다.
 *
 * 그래서 **경과만 내는 함수**(`lastTurnAgo`)가 아래에 있고, 접두를 붙인 문구는
 * `AgentsSettings.lastTurnLabel` 이 그것을 감싼다. 계산과 규율(미래 시각을 '방금'으로
 * 뭉개는 것, `null` 을 '없음'으로 말하는 것)은 **여기 한 벌뿐**이다.
 */

/**
 * `null` 은 **'활동 없음'** 이다 — '죽었다'가 아니다. murmur 는 러너 프로세스를 보지
 * 못하므로(`docs/design.md` §1 외부 접속형) 한 번도 턴을 돌리지 않았다는 것과 죽었다는
 * 것을 구분할 수단이 없고, 구분할 수 없는 것을 단정하면 그것이 §4 가 금지하는 거짓
 * 신호다. 오래된 값도 '멈췄다'가 아니다 — 아무도 부르지 않았으면 활동이 없는 것이 정상이다.
 *
 * 절대 시각을 그대로 쓰지 않는 이유: 운영자가 알고 싶은 것은 "얼마나 됐나"이고, 그것을
 * 사람이 시계와 뺄셈으로 계산하게 만들 이유가 없다. 대신 `title` 로 절대 시각을 함께 준다.
 */
export function lastTurnAgo(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '없음';
  const ms = now - new Date(iso).getTime();
  // 미래 시각은 서버가 now() 로 찍으므로 정상적으로는 오지 않는다(러너가 보낸 값을 저장하지
  // 않는 이유가 그것이다). 그래도 시계 보정이나 왕복 지연으로 음수가 될 수 있어, "N분 후"
  // 같은 말을 만들지 않고 '방금'으로 뭉갠다.
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}
