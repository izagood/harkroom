/**
 * 부팅 화면이 **무엇을 기다리는지** 말하는 자리(`#460`).
 *
 * ## 무엇이 문제였나 — 36분간 아무 말도 없었다 (실측 2026-09-05)
 *
 * 키체인 승인 대화상자가 뜬 채로 앱이 대기했고, 그동안 화면은 이 한 줄이었다:
 *
 * ```
 * Connecting…
 * ```
 *
 * **두 가지가 틀렸다.**
 *
 * | | 화면이 말한 것 | 실제 |
 * |---|---|---|
 * | 무엇을 하는가 | 서버에 접속 중 | 아직 세션도 못 읽었다 — 키체인을 기다린다 |
 * | 사람이 할 일 | (없다) | **시스템 대화상자를 찾아 승인을 누른다** |
 *
 * 사람은 36분을 기다렸고, 옆에서 누가 *"대화상자가 떠 있습니다"* 라고 알려 준 뒤에야
 * 풀렸다. **앱이 직접 말하면 중간에 낄 이유가 없다.**
 *
 * `#450` 이 고친 것은 **앱이 멎는 것**이고(메인 스레드 블로킹), 이것이 고치는 것은
 * **말하지 않는 것**이다. 둘은 다른 문제이고 둘 다 필요하다 — `#450` 이 없었으면 사람이
 * 대화상자를 누를 수조차 없었고, 이것이 없으면 누를 대화상자가 있는 줄을 모른다.
 *
 * ## 왜 곧바로 말하지 않고 유예를 두나
 *
 * 승인이 캐시돼 있으면 키체인 읽기는 **눈 깜빡할 사이**에 끝난다. 그때도 문구를 세우면
 * 정상 기동마다 "승인을 기다린다"가 한 프레임 번쩍이고, 그것은 사실이 아닌 데다
 * 곧 사람이 이 문구를 무시하게 만든다 — **가끔 보이는 말이라야 사람이 읽는다.**
 *
 * 그래서 **기다림이 실제로 길어졌을 때만** 말한다. 유예 자체는 판정이 아니다:
 * 문구는 여전히 관측(키체인을 두드렸다, `sessionStore.load` 의 `onKeychainWait`)에서만
 * 나오고, 유예는 *언제 말할지*만 정한다.
 *
 * ## 왜 상한(타임아웃)이 없나
 *
 * 승인을 기다리는 동안 이 대기는 **정상적으로** 오래 걸린다. 상한을 두고 실패로 접으면
 * 사람이 승인을 누른 뒤에도 화면은 이미 "실패"이고, 그것은 지금보다 나쁘다 —
 * `main.rs` 의 `secret_get` 주석이 같은 판단을 적어 두었다.
 */
import { useEffect, useState } from 'react';

/**
 * 이 시간이 지나도 키체인이 안 끝나면 말한다.
 *
 * **3초는 "승인 대화상자가 떴다"의 근거가 아니다** — 근거는 `onKeychainWait` 이고
 * 이 값은 *언제 말할지*만 정한다. 캐시된 읽기는 밀리초 단위로 끝나므로 이 문턱을
 * 넘는 일이 없고, 넘었다면 사람의 손을 기다리는 중일 가능성이 크다.
 *
 * 그래도 문구가 **단정하지 않는 것**은 그 "가능성이 크다"가 확신이 아니기 때문이다:
 * 잠긴 키체인이나 느린 Secret Service 도 여기 든다. 그래서 문구는 무엇을 기다리는지
 * (확실한 것)와 어디를 봐야 하는지(사람이 확인할 수 있는 것)를 말하고,
 * "대화상자가 떠 있다"고 **단언하지 않는다**(`#368`).
 */
export const KEYCHAIN_NOTICE_DELAY_MS = 3_000;

/** 무엇을 기다리는지 — **관측된 사실**이다. */
export const KEYCHAIN_WAIT_TITLE = 'OS 키체인의 승인을 기다리는 중';

/**
 * 사람이 다음에 할 수 있는 일. **이것이 빠지면 고친 게 아니다** — "기다리는 중"만으로는
 * 36분이 다시 일어난다(사람은 기다리면 되는 줄 안다).
 *
 * 다른 창 뒤에 가려질 수 있다는 것까지 말하는 이유: 실측에서 대화상자는 **떠 있었고**
 * 사람이 그것을 못 찾은 것이 대기의 실체였다.
 */
export const KEYCHAIN_WAIT_HINT =
  '시스템 승인 대화상자가 떠 있는지 확인하라 — 다른 창 뒤에 가려져 있을 수 있다. 승인하면 곧바로 이어진다.';

export type BootWait = 'unknown' | 'keychain';

/**
 * 부팅 중 한 줄. `wait` 가 `keychain` 이고 유예를 넘겼을 때만 사유를 펼친다.
 *
 * `wait` 를 안 받거나 `unknown` 이면 **아무 사유도 지어내지 않는다** — 앞 판본의 문구를
 * 그대로 둔다. 느린 이유를 모를 때 하나를 골라 적는 것이 정확히 이 이슈가 막으려는 짓이다.
 */
export function BootNotice({
  wait = 'unknown',
  delayMs = KEYCHAIN_NOTICE_DELAY_MS,
}: {
  wait?: BootWait;
  delayMs?: number;
}) {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    // 대기 종류가 바뀌면 유예를 다시 센다 — 키체인을 두드린 시점부터 재야 한다.
    setElapsed(false);
    if (wait !== 'keychain') return;
    const t = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(t);
  }, [wait, delayMs]);

  const speaking = wait === 'keychain' && elapsed;

  return (
    <div className="p-4 text-fg-muted" role="status" data-testid="boot-notice" data-boot-wait={speaking ? 'keychain' : 'unknown'}>
      {/* 이 줄은 그대로 둔다 — 유예 안에서는 이것이 아는 것의 전부다. */}
      <div>Connecting…</div>
      {/* 크기를 내리지 않는다 — 아래 두 줄에 적히는 것은 **사람이 다음에 무엇을 할 수
          있는지**이고, 그것을 아랫단 11px 로 두면 유일한 안내가 화면에서 가장 작은
          글자가 된다. 본문단 13px 은 앱 기본값이라 안 적는다. */}
      {speaking && (
        <div className="mt-2 max-w-md">
          <div className="text-fg">{KEYCHAIN_WAIT_TITLE}</div>
          {/* 사유만으로는 부족하다. **사람이 다음에 무엇을 할 수 있는지**가 이 이슈의 답이다. */}
          <div className="mt-1 text-fg-muted">{KEYCHAIN_WAIT_HINT}</div>
        </div>
      )}
    </div>
  );
}
