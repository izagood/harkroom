/**
 * daemon 이 **직접 확인한 사실**을 사람이 읽는 말로 바꾼다
 * (`#443`, 정본 문서 `docs/desktop-agent-cards.html` 3단계).
 *
 * ## 이 파일이 왜 `lib/` 에 있나
 *
 * `lastTurn.ts` 머리말이 그 규율을 세워 뒀다: **읽는 곳이 둘 이상인 순수 함수는 `lib/`
 * 에 둔다.** 여기서는 읽는 곳이 하나(상세 패널)이지만 **판정을 회귀선이 직접 재야
 * 한다**는 이유가 더 크다 — 이 파일이 지키는 규율 셋은 컴포넌트 안에 두면 렌더를 거쳐야만
 * 확인할 수 있고, 그러면 그 규율이 깨졌을 때 무엇이 깨졌는지가 문구 대조로만 드러난다.
 *
 * ## 이 파일이 지키는 규율 셋
 *
 * ### 1. 없는 것을 그리지 않는다 (규칙 06)
 *
 * 새 필드는 전부 옵셔널이다 — 옛 daemon 은 안 보낸다
 * (`runnerLauncher.ts::ObservedRunner` 주석). `undefined` 를 `0` 이나 `-` 로 꾸미지
 * 않고 **행 자체를 안 만든다.** 그래서 이 파일의 함수는 문자열이 아니라
 * `DaemonFactRow[]` 를 내고, 빈 배열이면 화면에 구획이 서지 않는다.
 *
 * ### 2. 사실만 적고 판정하지 않는다
 *
 * `daemonProtocol.ts::RunnerInfo.termSentAtMs` 가 경고한 자리다:
 *
 * > **N 의 정상 범위를 화면에 절대값으로 박지 마라.** 러너는 롱폴링
 * > (`AGENT_POLL_TIMEOUT_MS`, 기본 25초) 안에 갇혀 있어 그만큼은 정상인데, 그 값은
 * > 환경변수라 배포마다 다르고 **daemon 은 러너의 설정값을 모른다.**
 *
 * 그래서 이 파일에는 임계값 상수가 **하나도 없다.** *"3분이 지났으니 이상하다"* 를
 * 화면이 말하면 그 숫자는 `AGENT_POLL_TIMEOUT_MS` 를 늘려 둔 배포에서 곧 거짓이 된다.
 * 경과는 그냥 적고("보낸 지 4분 12초"), 이상한지는 사람이 정한다 — daemon 이 판단하지
 * 않는 것과 같은 이유다(`#431` D5: 소유는 프로세스 수준, 판단은 사람의 몫).
 *
 * ### 3. 종료 요청은 **누가 했는지 함께** 적는다
 *
 * 아래 `terminationRow` 의 주석이 그 표 전체를 다룬다.
 *
 * ## 문구는 사전에 있다 — 이 파일은 **무엇을 말할지만** 정한다
 *
 * 라벨과 값은 `i18n/en.ts` 의 `daemonFacts.*` 영역에 있고, 여기서는 `t()` 로 꺼낸다.
 * 그 영역을 `agents.*`(이 판정을 그리는 화면 이름)가 아니라 **판정 이름**으로 잡은
 * 근거는 그 머리말에 있다 — `waitChain` 이 세운 선례와 같다.
 *
 * **조각을 잇지 않는다.** 종료 요청 행은 `사람이 UI 에서 10:23 · 러너가 아직 못 읽음`
 * 인데, 이것을 `'사람이 UI 에서'` + 시각 + `'러너가 아직 못 읽음'` 으로 두면 어순이 이
 * 파일에 굳어 영어가 그 조각들을 놓을 자리를 잃는다. 그래서 자리표시자를 낀 **통짜
 * 문장**을 사전에 두고, 이 파일은 시각과 경과만 채워 넣는다. 같은 이유로 가동 행의
 * `부터`(조사)도 사전으로 갔다 — 영어에서 그 말은 시각 **앞**(`since`)에 선다.
 *
 * 남은 것은 구분자(` · ` · ` / `)뿐이다. 그것은 낱말이 아니라 목록을 잇는 기호라 사전에
 * 두지 않는다 — 두면 번역자가 그 자리에 문장을 적을 수 있게 된다.
 */
import type { ObservedRunner } from './runnerLauncher';
// 시간 표기는 **앱 전체가 한 벌**이다(`lib/time.ts` 머리말의 실측 표). 이 파일이 길이를
// 제 손으로 조립하면 같은 뜻이 두 벌이 되고, 그것이 이 함수의 옛 모습이었다.
import { durationLabel } from './time';
import type { Translate } from '../i18n';

/**
 * 상세에 서는 한 행. **라벨과 값이 갈려 있다** — 목업이 왼쪽에 라벨 칸, 오른쪽에 값 칸을
 * 세워 뒀고, 값 안에 라벨을 섞으면 `pid  pid 48127` 이 된다(`lastTurn.ts` 가 접두를
 * 함수 밖으로 뺀 것과 같은 사정).
 */
export interface DaemonFactRow {
  /** 회귀선이 이 행을 이름으로 집는 축. 화면의 `data-fact` 가 이 값이다. */
  key: 'pid' | 'uptime' | 'liveness' | 'termination' | 'signal';
  label: string;
  value: string;
}

/**
 * 두 시각의 차이를 사람이 읽는 길이로. **경과이지 판정이 아니다** — 위 규율 2.
 *
 * ## 두 벌이던 이름을 합쳤다(`#619` 후속)
 *
 * 이 함수는 `progressGroup.ts` 에도 **같은 이름으로** 있었다(시그니처만 달랐다 —
 * `(fromMs: number, now)` 와 `(startedAt: string, now)`). 이 저장소가 반복 결함으로
 * 지목한 *"같은 판정이 두 벌"* 의 모양이라, 서식은 `lib/time.ts::durationLabel` 하나로
 * 합치고 **이 자리 고유의 정책만** 여기 남겼다:
 *
 * - **1초 미만은 `방금` 이라고 말한다.** 저쪽(`progressGroup`)은 같은 자리에서 `null` 을
 *   내 자리를 비우는데, 여기서는 행이 서야 한다 — 상세의 표에서 값 칸이 비면 그것은
 *   "짧다"가 아니라 "못 읽었다"로 읽힌다.
 * - **초까지 내려간다.** 여기서 재는 것은 **종료 요청을 보낸 뒤의 기다림**이고 그것은
 *   초 단위로 읽어야 한다 — 롱폴링 한 바퀴가 기본 25초다(`AGENT_POLL_TIMEOUT_MS`).
 *   `durationLabel` 이 60초 미만을 초로 내므로 이 자리는 그대로 얻는다.
 *
 * 음수를 다루는 방식은 `agoLabel` 과 같게 둔다: 시계 보정으로 음수가 나올 수 있고,
 * 그때 "-3분"이라고 적으면 사람은 앱이 고장 났다고 읽는다. 뭉개는 것은 `durationLabel`
 * 안에 있다 — 이 앱이 시간을 말하는 모든 자리에 같게 걸려야 하는 규율이라 그쪽이 맞다.
 *
 * `locale` 과 `t` 를 인자로 받는 것은 `#619` 가 정한 **(b) 주입**이다 — 판정이 React
 * 컨텍스트에 묶이지 않고, 회귀선이 언어를 골라 넘겨 **문구를 계속 잰다**.
 */
export function elapsedLabel(
  fromMs: number,
  now: number,
  locale: string,
  t: Translate,
): string {
  const ms = now - fromMs;
  if (ms < 1_000) return t('time.justNow');
  return durationLabel(ms, locale);
}

/** 목업의 `2026-09-07 16:05` 꼴. 로케일 기본 포맷은 초까지 붙어 행이 두 줄로 넘어간다. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 시:분만. 목업의 종료 요청 행(`사람이 UI 에서 10:23`)이 이 꼴이다. */
function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 서버가 아는 종료 요청(`AgentConfig` 의 두 필드). daemon 은 이것을 **모른다**.
 *
 * ISO 문자열이 아니라 ms 로 받는 이유: 이 파일은 시각 파싱을 한 자리
 * (`AgentsSettings` 가 `Date.parse`)에 두고 여기서는 계산만 한다 — 파싱 실패를 이 순수
 * 함수가 문구로 꾸미기 시작하면 규율 1 이 무너진다.
 */
export interface ServerStopRequest {
  /** 사람이 UI 에서 중지를 건 시각. 안 걸었으면 `null`. */
  requestedAtMs: number | null;
  /** 러너가 그 요청을 **읽어 간** 시각(`#428`). 아직 안 읽었으면 `null`. */
  ackedAtMs: number | null;
}

/**
 * **두 출처를 합쳐 한 줄로 만든다**(`#443` 의 제약 1).
 *
 * ## 왜 합쳐야 하나 — 나란히 두면 모순으로 읽힌다
 *
 * `daemonProtocol.ts::RunnerInfo.termSentAtMs` 가 이 표를 들고 있다:
 *
 * | 출처 | 어디에 기록되나 | daemon 이 아는가 |
 * |---|---|---|
 * | 사람이 UI 에서 | 서버 DB 의 `stopRequestedAt`(`#428`) | **모른다** |
 * | daemon 이 시그널로 | `termSentAtMs` | 안다 |
 *
 * 사람이 UI 로 요청해 러너가 물러나는 중이어도 daemon 입장에서는
 * `termSentAtMs: null, alive: true` 다. 그 둘을 각자의 행에 따로 적으면 화면에
 * `종료 요청함 / alive · 시그널 안 보냄` 이 나오고, 사람은 **둘 중 하나가 거짓이라고
 * 읽는다.** 둘 다 사실이다 — 각 필드가 **자기 쪽의 행위만** 기록하기 때문이다.
 *
 * 그래서 이 함수가 내는 값은 항상 **누가 요청했는지로 시작한다**(`사람이 UI 에서`
 * 또는 `daemon 이 시그널로`). 주어가 붙으면 두 사실이 서로를 반박하지 않는다.
 *
 * ## 왜 두 행인가 — '종료 요청'과 '시그널'
 *
 * 목업이 그 둘을 갈라 뒀고(`종료 요청` 행과 `시그널` 행), 그것이 맞다: 앞은 *"누가
 * 물러나라고 했나"* 이고 뒤는 *"daemon 이 시그널을 보냈나"* 다. 한 행으로 접으면
 * daemon 이 안 보낸 경우를 말할 자리가 없어지고, 그러면 사람은 "요청은 갔는데 왜 안
 * 죽지"에서 **누가 무엇을 안 했는지**를 알 수 없다.
 *
 * `undefined` 를 받으면(옛 daemon) '시그널' 행은 서지 않는다 — 규율 1. 하지만
 * '종료 요청' 행은 **여전히 설 수 있다**: 서버 쪽 사실은 daemon 판본과 무관하게 온다.
 */
function terminationRows(
  runner: ObservedRunner,
  server: ServerStopRequest,
  now: number,
  locale: string,
  t: Translate,
): DaemonFactRow[] {
  const rows: DaemonFactRow[] = [];

  const daemonSent = typeof runner.termSentAtMs === 'number' ? runner.termSentAtMs : null;

  // ## '종료 요청' 행 — 주어가 먼저다
  //
  // 둘 다 요청했을 수도 있다(사람이 UI 에서 걸고, 이 앱이 재기동으로 죽이라고 했다).
  // 그때 **둘 다 적는다** — 하나만 골라 적으면 나머지 하나가 없는 일이 되고, 사람은
  // 자기가 누른 것이 반영됐는지를 확인할 자리를 잃는다.
  const requesters: string[] = [];
  if (server.requestedAtMs !== null) {
    // 러너가 읽어 갔는지까지 붙인다 — 목업의 `러너가 아직 못 읽음` 이 그것이다.
    // 이것을 빼면 "요청했는데 왜 안 멈추지"의 답(*"붙어 있지 않으면 읽어 갈 쪽이 없다"*,
    // `AgentsSettings` 의 중지 상태 표시)이 이 자리에서 사라진다.
    // **문장을 통째로 사전에 둔다** — `러너가 아직 못 읽음` 을 조각으로 두고 여기서
    // 이어 붙이면 어순이 이 파일에 굳는다(`waitChain.link` 머리말이 금지한 그것).
    // `{read}` 자리에 들어가는 것도 조각이 아니라 문장이라, 언어마다 그 자리를
    // 문장 앞으로 옮길 수도 있다.
    const read = server.ackedAtMs !== null
      ? t('daemonFacts.termination.read', { time: clock(server.ackedAtMs) })
      : t('daemonFacts.termination.unread');
    requesters.push(t('daemonFacts.termination.byPerson', {
      time: clock(server.requestedAtMs), read,
    }));
  }
  if (daemonSent !== null) {
    requesters.push(t('daemonFacts.termination.bySignal', { time: clock(daemonSent) }));
  }
  if (requesters.length > 0) {
    rows.push({
      key: 'termination',
      label: t('daemonFacts.label.termination'),
      // 두 요청을 잇는 ` / ` 는 사전에 안 넣는다 — 낱말이 아니라 **목록 구분자**이고,
      // 그것을 사전에 두면 번역자가 그 자리에 문장을 적을 수 있게 된다.
      value: requesters.join(' / '),
    });
  } else if (runner.termSentAtMs === null) {
    // daemon 이 **말한** `null` 이다("내가 안 보냈다"). 서버 쪽도 비었으므로 아무도
    // 요청하지 않았다고 말할 수 있다 — 두 출처를 다 봤기 때문에 말할 수 있는 것이고,
    // 그것이 이 함수가 두 출처를 함께 받는 이유다.
    rows.push({
      key: 'termination',
      label: t('daemonFacts.label.termination'),
      value: t('daemonFacts.termination.none'),
    });
  }
  // `termSentAtMs` 가 `undefined`(옛 daemon)이고 서버 쪽도 비었으면 행이 없다. 그때
  // '없다'라고 적으면 **모르는 것을 단정하는** 것이다 — daemon 쪽 절반을 못 봤으니까.

  // ## '시그널' 행 — daemon 자신의 행위만
  //
  // `undefined` 면 서지 않는다(옛 daemon 은 이 사실을 모른다).
  if (runner.termSentAtMs === null) {
    rows.push({
      key: 'signal',
      label: t('daemonFacts.label.signal'),
      value: t('daemonFacts.signal.none'),
    });
  } else if (daemonSent !== null) {
    // **경과만 적고 판정하지 않는다** — 규율 2. "N 초 지났는데 아직 살아 있다"는 사실이고
    // "그러니 이상하다"는 판정이다. 후자를 적으려면 러너의 롱폴링 예산을 알아야 하는데
    // daemon 도 이 화면도 그것을 모른다.
    //
    // 두 갈래를 **각각 한 문장으로** 사전에 둔다. 살아 있을 때만 붙는 꼬리를 조각으로
    // 두면 언어가 그것을 문장 앞으로 못 옮기고, `SIGTERM` 이 어느 자리에 오는지도
    // 이 파일이 정하게 된다.
    const waited = runner.alive
      ? t('daemonFacts.signal.sentStillAlive', {
        stamp: stamp(daemonSent),
        elapsed: elapsedLabel(daemonSent, now, locale, t),
      })
      : t('daemonFacts.signal.sent', { stamp: stamp(daemonSent) });
    rows.push({ key: 'signal', label: t('daemonFacts.label.signal'), value: waited });
  }

  return rows;
}

/**
 * 상세에 올릴 행들을 만든다. **`runner` 가 없으면 빈 배열** — daemon 이 이 에이전트에
 * 대해 아무것도 모른다는 뜻이고(장부에 없다), 그때 이 구획은 서지 않는다.
 *
 * 버전 행이 여기 없는 이유: `runnerVersion` 은 **서버가** 내려주는 값이고 daemon 이
 * 확인한 사실이 아니다(`runnerVersions.ts` 가 그 판정을 들고 있고, 상세는 이미 그것을
 * 다른 자리에서 그린다). 이 구획의 제목이 *"daemon 이 직접 확인한 것"* 이므로 daemon 이
 * 모르는 값을 여기 섞으면 제목이 거짓이 된다.
 */
export function daemonFactRows(
  runner: ObservedRunner | undefined,
  server: ServerStopRequest,
  now: number,
  locale: string,
  t: Translate,
): DaemonFactRow[] {
  if (!runner) return [];
  const rows: DaemonFactRow[] = [];

  // pid 와 세대를 **한 행에** 둔다(목업 그대로). 둘은 같은 질문의 답이다 — "지금 도는
  // 그 프로세스가 무엇인가". 세대만 있고 pid 가 없으면 세대만 적는다.
  const ident: string[] = [];
  if (typeof runner.pid === 'number') ident.push(String(runner.pid));
  if (typeof runner.incarnationId === 'string') {
    ident.push(t('daemonFacts.pid.incarnation', { id: runner.incarnationId }));
  }
  // pid 값은 숫자와 세대를 잇기만 한다 — 잇는 ` · ` 는 위 종료 요청 행의 ` / ` 와 같은
  // 이유로 사전 밖이다(구분자이지 낱말이 아니다).
  if (ident.length > 0) {
    rows.push({ key: 'pid', label: t('daemonFacts.label.pid'), value: ident.join(' · ') });
  }

  if (typeof runner.startedAtMs === 'number') {
    // **`부터` 를 이 파일에 남기지 않는다.** 그것은 조사이고, 영어에서는 그 자리가 아니라
    // 시각 앞(`since`)에 온다 — 조각으로 두면 영어가 그 말을 놓을 자리가 없다.
    rows.push({
      key: 'uptime',
      label: t('daemonFacts.label.uptime'),
      value: t('daemonFacts.uptime.since', {
        stamp: stamp(runner.startedAtMs),
        elapsed: elapsedLabel(runner.startedAtMs, now, locale, t),
      }),
    });
  }

  // ## '생사' 행은 **항상** 선다
  //
  // `alive` 는 옵셔널이 아니다 — 파싱 루프가 옛 daemon 에도 기본값을 준다(그쪽은 판정에
  // 쓰이므로 그래야 한다, `ObservedRunner` 주석). 그리고 이 행이 이 구획의 존재 이유에
  // 가장 가깝다: 서버는 러너가 말을 걸어올 때만 그 존재를 알아서 "실제로 종료했는지는
  // murmur 가 알 수 없다"고 적어 뒀는데(`#428`), **daemon 은 자기가 spawn 했으므로
  // 안다.** 그 사실이 화면까지 흐르는 자리가 여기다.
  //
  // 어떻게 알았는지를 값에 함께 적는다(`kill(pid, 0) 확인`) — 관측이지 판단이 아니라는
  // 것을 사람이 볼 수 있어야 하고, 그것이 이 구획 전체의 태도다.
  rows.push({
    key: 'liveness',
    label: t('daemonFacts.label.liveness'),
    value: runner.alive
      ? t('daemonFacts.liveness.alive')
      : t('daemonFacts.liveness.dead'),
  });

  rows.push(...terminationRows(runner, server, now, locale, t));
  return rows;
}
