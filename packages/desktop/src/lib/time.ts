/**
 * **시간 표기 한 벌**(`#619` 후속). 이 앱이 시간을 말하는 자리는 전부 여기를 지난다.
 *
 * ## 왜 사전이 아니라 여기인가 — 후보 셋을 실측으로 갈랐다
 *
 * `#619`(i18n 뼈대)가 이것을 **먼저 정하라**고 남겼다: 시간 문구를 사전에 넣으면
 * 언어마다 `{n}분 전`·`{n} minutes ago` 조합을 다시 쓰게 되고, `Intl` 로 가면 사전에서
 * 빠진다. 아홉 화면이 각자 다르게 처리하기 전에 답이 있어야 했다.
 *
 * 지금 네 함수가 내던 문구를 **전부 나열해 `Intl` 에 실제로 돌려 봤다**
 * (2026-09-08, Node 24 · jsdom · JavaScriptCore 셋에서 같은 결과).
 *
 * | 지금 문구 | `Intl` 이 내는 것 | 같나 |
 * |---|---|---|
 * | `11분 전` | `RelativeTimeFormat.format(-11, 'minute')` → `11분 전` | O |
 * | `1시간 전` | `format(-1, 'hour')` → `1시간 전` | O |
 * | `1일 전` | `format(-1, 'day')` (`numeric: 'always'`) → `1일 전` | O |
 * | `42초` | `DurationFormat.format({seconds: 42})` → `42초` | O |
 * | `4분 12초` | `format({minutes: 4, seconds: 12})` → `4분 12초` | O |
 * | `4시간 12분` | `format({hours: 4, minutes: 12})` → `4시간 12분` | O |
 * | `2일 5시간` | `format({days: 2, hours: 5})` → `2일 5시간` | O |
 * | `오늘` | `format(0, 'day')` (`numeric: 'auto'`) → `오늘` | O |
 * | `어제` | `format(-1, 'day')` (`numeric: 'auto'`) → `어제` | O |
 * | **`방금`** | 가장 가까운 것이 `format(-0, 'second')` → **`지금`** | **X** |
 * | **`3분째`** | `DurationFormat` → **`3분`** (`째` 를 낼 방법이 없다) | **X** |
 * | **`없음`** | 시간이 아니다 — 잴 값 자체가 `null` 이다 | **X** |
 *
 * 그래서 **C(섞는다)** 다. 갈라지는 자리가 우연이 아니라 **종류가 다르기 때문**이라는
 * 것이 이 표가 말하는 것이다:
 *
 * - `Intl` 이 내는 것은 전부 **수량**이다(얼마나 지났나 · 얼마나 걸렸나). 수량의 복수형과
 *   어순과 단위 이름은 언어의 문법이고, 그것은 플랫폼이 우리보다 잘 안다.
 * - `Intl` 이 못 내는 셋은 전부 **수량이 아니다**. `방금` 은 "숫자를 말하지 않기로 한
 *   결정"이고, `째` 는 "아직 도는 중"이라는 **상[aspect]** 이고, `없음` 은 "잴 것이
 *   없다"는 사실이다. 셋 다 우리가 정한 뜻이라 **사전의 것**이다.
 *
 * A(전부 `Intl`)를 버린 이유가 그 셋이다 — `방금`·`3분째`·`없음` 을 `Intl` 이 못 낸다.
 * B(전부 사전)를 버린 이유는 표의 O 아홉 줄이다: 그 아홉을 사전에 넣으면 세 번째 언어가
 * `{n}분 전`·`{n}시간 전`·`{n}일 전`·`{n}분 {n}초`… 를 전부 다시 쓰고, 러시아어처럼
 * 복수형이 네 갈래인 언어에서는 그 곱만큼 늘어난다. 플랫폼이 이미 아는 것을 사전에
 * 옮겨 적는 것이 곧 그 언어들의 부채다.
 *
 * **경계가 한 줄로 말해진다: 숫자는 `Intl` 이, 뜻은 사전이.**
 *
 * ## 길이는 왜 `DurationFormat` 이 아니라 `NumberFormat` + `ListFormat` 인가
 *
 * `RelativeTimeFormat` 만으로는 `4분 12초` 를 못 낸다(그것은 "언제"가 아니라 "얼마나
 * 오래"다 — 단위가 둘이다). 그 자리를 정확히 채우는 것이 `Intl.DurationFormat` 인데,
 * **이 저장소는 그것을 쓸 수 없다.**
 *
 * 처음엔 썼고, 배포 엔진에서 확인까지 했다. 그런데 **CI 가 통째로 무너졌다**
 * (`TypeError: Intl.DurationFormat is not a constructor`, 7개 파일 51개 테스트).
 * 확인한 환경이 실제로 도는 환경 전부가 아니었던 것이다:
 *
 * | 환경 | `Intl.DurationFormat` |
 * |---|---|
 * | JavaScriptCore(macOS 26.5) — **배포본이 도는 엔진** | 있다 |
 * | Node 24 — 개발 기계 | 있다 |
 * | **Node 22 — CI 러너**(`.github/workflows/ci.yml`) | **없다** |
 *
 * `Intl.DurationFormat` 은 **Node 23+** 다. 그런데 이 저장소는 `package.json` 에
 * `engines: { node: ">=22" }` 를 선언하므로 **Node 22 에서 돌아야 한다** — CI 를 Node 24
 * 로 올려 초록을 만드는 것은 선언과 실제를 어긋나게 하면서 Node 22 기여자를 막는 일이라
 * 택하지 않았다.
 *
 * **다음 사람에게 남기는 함정**: 배포 엔진에서 되는 것이 곧 회귀선에서 되는 것이 아니다.
 * 새 `Intl` API 를 들일 때는 **배포 엔진과 `engines` 의 하한(지금 Node 22) 둘 다**에서
 * 재라. 그리고 `mise exec node@22 -- npx vitest` 로는 **확인이 안 된다** — `npx` 가
 * 시스템 Node 로 되돌아가 실제로는 Node 24 에서 돈다(이 함정에 한 번 빠졌다). 하한을
 * 실제로 재려면 그 버전의 `node` 실행 파일로 vitest 를 직접 불러야 한다 —
 * mise 라면 `~/.local/share/mise/installs/node/22.x.y/bin/node` 를 찾아
 * `./node_modules/vitest/vitest.mjs run` 에 붙인다.
 *
 * 그래서 **`DurationFormat` 이 하던 일을 Node 22 에 있는 `Intl` 둘로 조립한다**:
 * `NumberFormat({style: 'unit'})` 이 단위 하나를 그 언어의 말로 적고
 * (`4` → `4시간`/`4h`), `ListFormat({type: 'unit'})` 이 그것들을 그 언어의 방식으로
 * 잇는다(`4시간 12분` / `4h 12m`). **이것은 손으로 만든 폴백이 아니다** — 단위 이름도
 * 잇는 방식도 우리가 안 적고 `Intl` 이 낸다. 그래서 이 파일의 경계("숫자는 `Intl`, 뜻은
 * 사전")가 그대로고, **세 번째 언어를 붙이는 비용도 그대로 0 이다**(사전에 시간 단위
 * 이름이 안 늘어난다).
 *
 * 조립이 `DurationFormat` 과 **같은 글자를 내는지 실측으로 확인했다**(2026-09-08).
 * 초·분·시·일 4,932 개 조합을 ko·en 두 언어로 네이티브와 한 글자씩 비교했다:
 *
 * | 환경 | 네이티브와 다른 조합 |
 * |---|---|
 * | JavaScriptCore(macOS 26.5) — **배포 엔진** | 0 / 3,970 |
 * | Node 24 | 0 / 4,932 (아래 `0` 한 줄 빼고) |
 * | Node 22 | 네이티브가 없어 비교 불가 — 조립 결과는 위 둘과 같다 |
 *
 * **테스트가 배포와 다른 것을 재지 않는다**: 폴리필을 테스트에만 넣는 길(그러면 회귀선이
 * 배포본과 다른 구현을 잰다)을 버린 이유가 이것이다. 지금은 세 환경이 **전부 같은 코드**를
 * 돌린다 — 분기가 없으니 "어느 쪽이 도는가"를 물을 필요 자체가 없다.
 *
 * 유일하게 갈리는 자리가 `0` 인데, **그쪽은 조립이 오히려 옳다**: 네이티브
 * `DurationFormat` 은 `{seconds: 0}` 을 **빈 문자열**로 내서 `secondsDisplay: 'always'`
 * 짜리 서식기를 따로 둬야 했는데, 조립은 그냥 `0초`/`0s` 를 낸다. 그래서 그 서식기가
 * 사라졌다(아래 `durationLabel` 참고).
 */
import type { Translate } from '../i18n';

/**
 * 길이를 말할 때 쓰는 단위들. `pickUnits` 가 고르고 `formatDuration` 이 글자로 만든다.
 *
 * 순서가 **큰 것부터**인 것이 계약이다 — 아래 `formatDuration` 이 이 순서대로 이어 붙인다.
 * 값은 `Intl.NumberFormat` 의 `unit` 이름이라 **마음대로 못 바꾼다**(허용 목록이 있다).
 */
const DURATION_UNITS = [
  ['days', 'day'],
  ['hours', 'hour'],
  ['minutes', 'minute'],
  ['seconds', 'second'],
] as const;

/** `pickUnits` 가 고른 단위 묶음. `Intl.DurationFormat` 의 입력과 같은 모양이다. */
type DurationInput = {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
};

/**
 * 서식기를 만들 때마다 새로 만들지 않는다. `Intl` 생성자는 로캘 자료를 훑으므로 목록을
 * 그리는 자리(카드 수십 개)에서 렌더마다 만들면 그것이 그대로 비용이다.
 *
 * 키에 로캘이 들어가므로 **언어를 바꾸면 다른 서식기가 나온다** — 캐시가 옛 언어를 붙들지
 * 않는다는 뜻이고, 그것이 이 화면에서 언어 전환이 즉시 먹는 이유다.
 */
const relativeCache = new Map<string, Intl.RelativeTimeFormat>();
const unitCache = new Map<string, Intl.NumberFormat>();
const listCache = new Map<string, Intl.ListFormat>();

function relative(locale: string, numeric: 'auto' | 'always'): Intl.RelativeTimeFormat {
  const key = `${locale}:${numeric}`;
  let f = relativeCache.get(key);
  if (f === undefined) {
    f = new Intl.RelativeTimeFormat(locale, { numeric });
    relativeCache.set(key, f);
  }
  return f;
}

/** 단위 하나를 그 언어의 말로 — `4` + `hour` → `4시간`/`4h`. */
function unit(locale: string, u: string): Intl.NumberFormat {
  const key = `${locale}:${u}`;
  let f = unitCache.get(key);
  if (f === undefined) {
    // `narrow` 를 고른 이유: 한국어는 셋(`long`·`short`·`narrow`)이 전부 `4분 12초` 로
    // 같고, 영어만 갈린다(`4 minutes` / `4 min` / `4h`). 이 값이 서는 자리는 카드의 좁은
    // 칸과 상세의 값 칸이라 **줄을 넘기면 안 된다** — `long` 의 `4 minutes, 12 seconds`
    // 는 그 칸에서 두 줄이 된다(`daemonFacts.ts` 의 `stamp()` 가 초를 뗀 것과 같은 사정).
    f = new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' });
    unitCache.set(key, f);
  }
  return f;
}

/**
 * 단위 둘을 그 언어의 방식으로 잇는다 — `['4시간', '12분']` → `4시간 12분`.
 *
 * `type: 'unit'` 이 요점이다. 기본값(`'conjunction'`)은 `4시간 및 12분`·`4h and 12m` 처럼
 * **접속사를 넣는다** — 그것은 길이를 말하는 말이 아니다. `'unit'` 이 `DurationFormat` 이
 * 쓰는 것과 같은 이음이고, 위 주석의 실측이 그것을 확인한 것이다.
 */
function list(locale: string): Intl.ListFormat {
  let f = listCache.get(locale);
  if (f === undefined) {
    f = new Intl.ListFormat(locale, { style: 'narrow', type: 'unit' });
    listCache.set(locale, f);
  }
  return f;
}

/**
 * `Intl.DurationFormat` 이 하던 일 — 단위 묶음을 그 언어의 글자로.
 *
 * **왜 `DurationFormat` 을 안 부르는지는 이 파일 맨 위에 있다**(Node 22 에 없다).
 * 여기서 우리가 정하는 것은 **무엇을 말할지**(`pickUnits` 가 고른 단위)뿐이고, 단위
 * 이름도 잇는 방식도 전부 `Intl` 이 낸다 — 그래서 언어를 붙일 때 여기 손댈 것이 없다.
 */
function formatDuration(locale: string, input: DurationInput): string {
  const parts: string[] = [];
  for (const [key, u] of DURATION_UNITS) {
    const v = input[key];
    if (v !== undefined) parts.push(unit(locale, u).format(v));
  }
  return list(locale).format(parts);
}

/**
 * 길이를 어느 해상도까지 말할 것인가. **부르는 쪽이 고른다.**
 *
 * - `'fine'` — 아랫단위까지(`4분 12초`). 종료 요청 뒤의 기다림처럼 **초가 뜻을 갖는**
 *   자리다(롱폴링 한 바퀴가 기본 25초다).
 * - `'coarse'` — 큰 단위 하나만(`4분`). 진행 줄처럼 **자라는 숫자를 곁눈으로 읽는**
 *   자리다 — 거기서 초까지 적으면 매 초 글자가 바뀌어 옆의 이름과 상태를 읽기 어렵다.
 *
 * 이 축을 `durationLabel` 안의 판단으로 못 만든다: 같은 4분 12초를 상세는 초까지
 * 읽어야 하고 진행 줄은 읽으면 안 된다. **정책이지 서식이 아니다.**
 */
export type Grain = 'fine' | 'coarse';

/**
 * 밀리초를 **어떤 단위로 말할지** 고른다. 한 단계만 내려간다 — `2일 5시간 3분 12초` 는
 * 사람이 읽는 말이 아니라 계산 결과다.
 *
 * 반환이 `DurationInput` 인 이유: 단위 선택은 우리 판단이고(무엇을 말할지),
 * 그것을 **글자로 만드는 것**은 `Intl` 의 일이다. 둘을 안 섞는다.
 *
 * **아랫단위가 `0` 이면 빼고 준다.** `{minutes: 1, seconds: 0}` 을 그대로 넘기면
 * `Intl` 이 `1분 0초` 를 내는데, 옛 `daemonFacts.elapsedLabel` 도 그것을 피해 있었다.
 * `0` 은 정보가 아니라 자리를 차지하는 잡음이다(규칙 06).
 */
function pickUnits(ms: number, grain: Grain): DurationInput {
  const secs = Math.floor(ms / 1_000);
  if (secs < 60) return { seconds: secs };
  const drop = (big: DurationInput, small: DurationInput): DurationInput =>
    (grain === 'coarse' || Object.values(small)[0] === 0) ? big : { ...big, ...small };
  const mins = Math.floor(secs / 60);
  if (mins < 60) return drop({ minutes: mins }, { seconds: secs % 60 });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return drop({ hours }, { minutes: mins % 60 });
  return drop({ days: Math.floor(hours / 24) }, { hours: hours % 24 });
}

/**
 * **"얼마나 전"** — 지난 시각 하나를 사람이 읽는 말로(`11분 전` · `11 minutes ago`).
 *
 * 하한이 `time.justNow` 인 것은 **사전의 판단**이다: `0분 전` 은 사람이 쓰지 않는 말이고
 * (`minutesAgo.ts` 가 처음 적어 둔 근거), `Intl` 이 그 자리에 내는 `지금`/`now` 는
 * 이 앱이 고른 말이 아니다. 숫자를 말하지 않기로 한 결정이므로 사전이 들고 있는다.
 *
 * **음수를 지어내지 않는다.** 시계 보정이나 왕복 지연으로 미래 시각이 올 수 있는데,
 * 그때 `11분 후` 라고 적으면 사람은 앱이 고장 났다고 읽는다(`lastTurn.ts` 가 세운 규율).
 * `Math.max(0, …)` 로 뭉개면 곧 `time.justNow` 로 떨어진다.
 *
 * `numeric: 'always'` 다 — 하루 전을 `어제` 라고 하지 않는다. 이 값이 서는 자리는
 * "마지막 활동이 얼마나 됐나"이고 그 답은 **길이**여야 한다(`어제` 는 달력의 말이라
 * 25시간 전과 47시간 전을 같은 말로 만든다). 달력을 말하는 자리는 `dayLabel` 이고,
 * 그쪽은 `numeric: 'auto'` 를 쓴다 — 같은 API 를 **다른 뜻으로** 부르는 것이다.
 *
 * ## 합치면서 `minutesAgo` 쪽 화면이 바뀐다 — 그것이 이 합침의 요점이다
 *
 * 옛 `minutesAgo` 는 **분에서 멈춰 있었다**: 한 시간 전이 `60분 전`, 하루 전이
 * `1440분 전`, 한 달 전이 `41760분 전` 이었다. 옛 `lastTurnAgo` 는 같은 물음에
 * `1시간 전`·`1일 전` 이라고 답했다 — **같은 뜻을 두 함수가 다르게 말하고 있었다.**
 *
 * 둘을 합치면 하나로 수렴할 수밖에 없고, 수렴할 쪽은 `lastTurnAgo` 다. 이유가
 * `lastTurn.ts` 에 이미 적혀 있다 — *"운영자가 알고 싶은 것은 '얼마나 됐나'이고, 그것을
 * 사람이 시계와 뺄셈으로 계산하게 만들 이유가 없다."* `41760분 전` 은 그 문장이 막으려던
 * 바로 그것이다: 사람이 나눗셈을 해야 뜻이 나온다.
 *
 * 바뀌는 자리는 투영 띠와 리스 목록 둘이고(`projectionBanner` 가 이 함수를 받는다),
 * 그 화면이 말하는 것은 *"투영이 얼마나 오래 멈춰 있나"* 다. 하루 넘게 멈춘 투영을
 * `1440분 전부터` 라고 적는 것보다 `1일 전부터` 가 그 사실을 더 곧게 말한다.
 */
export function agoLabel(fromMs: number, now: number, locale: string, t: Translate): string {
  const ms = Math.max(0, now - fromMs);
  if (!Number.isFinite(ms) || ms < 60_000) return t('time.justNow');
  const mins = Math.floor(ms / 60_000);
  const f = relative(locale, 'always');
  if (mins < 60) return f.format(-mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return f.format(-hours, 'hour');
  return f.format(-Math.floor(hours / 24), 'day');
}

/**
 * **"얼마나 오래"** — 두 시각의 차이를 길이로(`4분 12초` · `4m 12s`).
 *
 * ## 두 벌이던 `elapsedLabel` 을 여기 하나로 합쳤다
 *
 * `progressGroup.ts` 와 `daemonFacts.ts` 에 같은 이름의 함수가 시그니처만 다르게 있었다
 * (`(startedAt: string, now)` 와 `(fromMs: number, now)`). 이 저장소가 반복 결함으로
 * 지목한 *"같은 판정이 두 벌"* 의 모양이라 **합칠 수 있는지부터 봤다.**
 *
 * 각 주석이 적어 둔 차이는 셋이었고, 재 보니 **셋 다 서식의 차이가 아니었다**:
 *
 * | 차이 | 어느 쪽 판단인가 |
 * |---|---|
 * | 한쪽은 초까지, 한쪽은 분까지 | **부르는 쪽**이다 → `grain` 인자로 남았다(위 `Grain`) |
 * | 한쪽은 1분 미만에 `null`, 한쪽은 `방금` | **부르는 쪽**이다. 진행 줄은 `0분째` 를 안 그리려고 자리를 비우고(`progressGroup.elapsedMs`), 상세는 행이 서야 하므로 말을 한다(`daemonFacts.elapsedLabel`) |
 * | 한쪽은 `째`, 한쪽은 안 붙음 | **문구**다. 아래 `runningLabel`·`tookLabel` 이 그 자리다 |
 *
 * 남는 공통은 **"ms 를 단위로 갈라 그 언어의 말로 적는다"** 하나이고 그것이 이 함수다.
 * `grain` 을 인자로 받는 것이 정책을 도로 끌고 들어온 것 아니냐는 물음에 답을 적어 둔다:
 * **아니다 — 정책은 값을 고르는 쪽에 있고 여기 있는 것은 그 값을 받는 손잡이다.** 셋째
 * 갈래(`null` 이냐 `방금` 이냐)를 여기 넣지 않은 것이 그 선의 증거다. 그것은 문구를
 * 고르는 판단이라 부르는 쪽에 남았다.
 *
 * **음수는 `0` 으로 뭉갠다** — `agoLabel` 과 같은 규율이고, 회귀선이 그것을 잰다.
 */
export function durationLabel(ms: number, locale: string, grain: Grain = 'fine'): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  /**
   * **1초 미만도 `0초`·`0s` 라고 말한다.** 빈 칸으로 두면 "짧다"가 아니라 **"못 읽었다"**
   * 로 읽힌다(`daemonFacts.ts` 규율 1 의 거울상). 옛 `formatDuration` 이 그렇게 말했고,
   * 그 판단을 지킨다.
   *
   * 여기 분기가 없는 것이 위 조립(`NumberFormat` + `ListFormat`)의 덤이다. 네이티브
   * `Intl.DurationFormat` 은 `{seconds: 0}` 을 **빈 문자열**로 내서
   * `secondsDisplay: 'always'` 짜리 서식기를 따로 두고 0 일 때만 그리로 보내야 했는데
   * (그 서식기를 전체에 쓰면 `4시간 12분` 이 `4시간 12분 0초` 가 된다), 조립은 `0` 도
   * 그냥 한 단위로 적는다.
   * `pickUnits` 가 이미 `{seconds: 0}` 을 돌려주므로 아래 한 줄이 그대로 `0초` 를 낸다.
   */
  return formatDuration(locale, pickUnits(safe, grain));
}

/**
 * **"얼마나 오래, 아직 도는 중"** — `3분째` · `running 3m`.
 *
 * `durationLabel` 과 갈라 두는 이유가 이 PR 에서 가장 중요한 자리다. `째` 는 길이가
 * 아니라 **상[aspect]** 이다 — "3분이 걸렸다"와 "3분째 돌고 있다"는 다른 사실이고,
 * `Intl` 은 후자를 낼 방법이 없다(`DurationFormat` 은 `3분` 까지다).
 *
 * 그리고 이것을 **사전 항목으로 둬야만** 하는 이유가 따로 있다: 이전 코드는
 * `ProgressRow` 에서 `elapsed.replace(/째$/, '')` 로 끝난 묶음의 `째` 를 떼고 있었다.
 * 한국어 어미를 정규식으로 자르는 것이라 **다른 언어에서는 아무것도 안 잘린다** —
 * 영어 화면이 "끝난 진행"과 "도는 진행"을 같은 글자로 말하게 된다. 두 상태를 사전
 * 항목 둘로 두면 각 언어가 제 방식으로 가른다(영어는 `running 3m` / `took 3m`).
 */
export function runningLabel(ms: number, locale: string, t: Translate): string {
  // **`coarse` 다.** 이 줄은 곁눈으로 읽는 자리라 초까지 적으면 매 초 글자가 바뀌어
  // 옆의 이름과 상태를 읽기 어렵다 — 옛 `progressGroup.elapsedLabel` 이 분·시간만 낸
  // 것이 그 판단이었고, 합치면서 잃지 않는다.
  return t('time.running', { duration: durationLabel(ms, locale, 'coarse') });
}

/** `runningLabel` 의 짝 — **끝난** 진행의 길이(`3분` · `took 3m`). 위 주석이 근거다. */
export function tookLabel(ms: number, locale: string, t: Translate): string {
  return t('time.took', { duration: durationLabel(ms, locale, 'coarse') });
}
