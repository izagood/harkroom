import { MIN_SERVER_VERSION, compareRelease, serverCompat, type ServerVersion } from '@murmur/shared';
import type { Translate } from '../i18n';

/**
 * **커뮤니티 한 줄이 서버 버전에 대해 말하는 것**(#693).
 *
 * ## 왜 이 화면에 버전이 있어야 하나
 *
 * murmur 는 하루에도 여러 번 릴리스되고, 배포된 서버는 **조용히 낡는다.** 지금까지 설정의
 * 커뮤니티 목록이 말하는 것은 `Connected` 하나뿐이라, "지금 붙어 있는 서버가 어제 코드인가"
 * 를 알 방법이 없었다 — 사람이 재배포 여부를 정하려면 `docker inspect` 를 쳐야 했다.
 * 실제로 머지 10분 **전**에 빌드된 이미지가 34시간을 돌았고, 그 사이 그 머지가 막았어야 할
 * 사고가 났다(2026-09-10). 화면이 버전을 말했다면 눈에 띄었을 일이다.
 *
 * ## 왜 판정을 컴포넌트 밖으로 뽑았나
 *
 * "서버가 뒤처졌다"는 **비교 판정**이라 회귀선이 시각과 버전을 고정해 재야 한다
 * (`projectionBanner` 와 같은 이유). 컴포넌트 안에 두면 그 표를 렌더 트리로만 잴 수 있다.
 *
 * ## 다섯 사정을 뭉개지 않는다 (`docs/design.md` §4)
 *
 * ① 버전을 아직 못 받았다 ② 서버가 그 필드를 안 싣는 옛 판이다 ③ **호환 하한보다 낮다**
 * ④ 앱보다 뒤처졌지만 하한은 넘는다 ⑤ 같거나 앞선다.
 *
 * ①·② 를 갈라야 하는 이유: **②는 그 자체로 "재배포하라"는 답이다**(버전을 싣는 판보다
 * 낡았다는 뜻이므로).
 *
 * **③·④ 를 가르는 것이 이 판본이 더한 전부다.** 앞 판본은 "앱과 다르다"만 봤는데, 그것은
 * 거의 **항상** 참이다 — 릴리스는 하루에도 여러 번 돌고 서버는 사람이 손으로 재배포하기
 * 때문이다. 거의 언제나 켜지는 경고는 아무도 안 본다. 사람이 답해야 할 질문은 "다른가"가
 * 아니라 **"이 서버에서 이 앱이 도는가"** 이고, 그 답은 `MIN_SERVER_VERSION` 이 안다.
 *
 * 그래서 색이 셋이다: 하한보다 낮으면 **고장(danger)**, 뒤처졌지만 도는 것은 **주의
 * (warning)**, 나머지는 색 없음. 고장과 주의가 같은 색이면 둘 다 안 보인다.
 */
export interface ServerVersionLine {
  /** 회귀선이 사정을 구별해 물을 수 있도록 사정마다 다르다. */
  testid: 'server-version-unknown' | 'server-version-legacy' | 'server-version-incompatible'
    | 'server-version-same' | 'server-version-behind' | 'server-version-ahead';
  /**
   * 줄에 그대로 붙는 짧은 말(`v0.1.174`). **버전을 모르면 그 사실을 적는다** — 자리를
   * 비워 두면 "버전이 없는 서버"처럼 보인다.
   */
  text: string;
  /**
   * **고장과 주의는 다른 색이다.** `danger` 는 호환 하한보다 낮은 서버 하나뿐이다 — 그때만
   * 기능이 실제로 죽는다. 뒤처졌지만 도는 서버는 `warning`(해도 되고 안 해도 되는 일),
   * 같거나 앞선 서버는 색이 없다. 셋을 두 색으로 뭉개면 "지금 고쳐야 하는 것"이 묻힌다.
   */
  tone: 'danger' | 'warning' | 'muted';
  /**
   * 한 줄 더 적을 것. `null` 이면 없다. 뒤처졌을 때 **무엇과 견줘서** 그렇게 말하는지를
   * 밝힌다 — 숫자만 보여 주면 사람이 앱 버전을 따로 찾아야 한다.
   */
  detail: string | null;
  /** 기동 시각을 사람 말로(`3시간 전`). 못 받았으면 `null`. */
  started: string | null;
  /** 빌드에 심긴 커밋. 없으면 `null` — 지어내지 않는다. */
  commit: string | null;
}

export function serverVersionLine(input: {
  /** 서버가 말한 것. `null` 은 **아직 안 물어봤다**(붙기 전) 이다. */
  server: ServerVersion | null;
  /** 이 앱의 릴리스 번호(`__APP_VERSION__`). 같은 저장소에서 나온 숫자라 견줄 수 있다. */
  appVersion: string;
  /** '얼마나 전'을 지금 언어로 바꾸는 것은 화면의 일이라 주입받는다(`useAgo`). */
  ago(timestampMs: number): string;
  t: Translate;
}): ServerVersionLine {
  const { server, appVersion, ago, t } = input;

  // 기동 시각은 어느 사정에서도 같은 방식으로 읽는다. 빈 문자열은 "못 받았다"이고
  // (`api.ts::serverVersion` 이 그렇게 눕힌다), 파싱 못 하는 값도 같은 자리로 떨어진다 —
  // `NaN` 을 `ago()` 에 넘기면 그 함수가 `방금` 이라고 **거짓말**을 하게 된다.
  const startedMs = server?.startedAt ? Date.parse(server.startedAt) : NaN;
  const started = Number.isFinite(startedMs) ? ago(startedMs) : null;
  const commit = server?.commit ?? null;

  if (server === null) {
    return {
      testid: 'server-version-unknown', tone: 'muted',
      text: t('community.version.unknown'), detail: null, started: null, commit: null,
    };
  }

  if (server.version === null) {
    // 버전을 안 싣는 서버. **이것 자체가 답이다** — 이 필드가 생긴 판보다 낡았다는 뜻이라
    // 재배포하면 숫자가 뜬다. 그래서 `muted` 가 아니라 눈에 띄는 색을 준다.
    return {
      testid: 'server-version-legacy', tone: 'warning',
      text: t('community.version.legacy'),
      detail: t('community.version.legacyDetail'), started, commit,
    };
  }

  const text = t('community.version.value', { version: server.version });

  // **호환 하한을 먼저 본다** — 순서가 뜻을 정한다. 하한보다 낮은 서버는 앱보다 뒤처진
  // 서버이기도 하지만, 두 말 중 사람이 들어야 하는 것은 "기능이 죽는다" 쪽이다.
  // '뒤처졌다' 를 먼저 그리면 정작 고쳐야 할 것이 부드러운 문구에 묻힌다.
  if (serverCompat(server.version) === 'too-old') {
    return {
      testid: 'server-version-incompatible', tone: 'danger',
      text: t('community.version.incompatible', { version: server.version }),
      detail: t('community.version.incompatibleDetail', { minVersion: MIN_SERVER_VERSION }),
      started, commit,
    };
  }

  const cmp = compareRelease(server.version, appVersion);

  if (cmp === null || cmp === 0) {
    // 견줄 수 없는 모양(자체 빌드·포크)은 **숫자만 적고 판단하지 않는다.** 견주지 못하는
    // 것을 '같다'고도 '다르다'고도 말하지 않는 것이 이 화면의 정직한 답이다.
    return {
      testid: cmp === 0 ? 'server-version-same' : 'server-version-unknown',
      tone: 'muted', text, detail: null, started, commit,
    };
  }

  if (cmp < 0) {
    // 뒤처졌지만 **하한은 넘는다**(위에서 걸러졌다). 그래서 문구가 "재배포해라"가 아니라
    // 무엇을 확인했는지를 적는다 — 사람이 지금 당장 할 일은 없다는 것이 이 줄의 내용이다.
    return {
      testid: 'server-version-behind', tone: 'warning', text,
      detail: t('community.version.behindDetail', { appVersion, minVersion: MIN_SERVER_VERSION }),
      started, commit,
    };
  }

  // 서버가 앞선다. 흔한 일이다(서버를 먼저 배포한다) — 사람이 할 일이 없으므로 색을 안 준다.
  return {
    testid: 'server-version-ahead', tone: 'muted', text,
    detail: t('community.version.aheadDetail', { appVersion }), started, commit,
  };
}
