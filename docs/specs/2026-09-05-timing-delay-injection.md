# 지연 주입 통제 실험 — 스위트 전체 실측 (#392)

`#367` 후속. 이 문서가 이슈 #392 의 산출물이다: **도구가 무엇이고, 그것으로 스위트
전체를 돌렸을 때 무엇이 빨개졌고, 그 각각이 진짜 결함인지 예산 초과인지**를 남긴다.
남기지 않으면 다음 사람이 같은 실측을 처음부터 반복한다(#347 이 지적한 실패다).

## 도구

`packages/desktop/test/setup.ts` 안에 있다. `MURMUR_TEST_DELAY_MS` 를 주면 켜지고,
안 주면 **모듈 로드 시점의 `if (__delayMs > 0)` 하나가 통째로 안 들어가** 아무 것도
감싸지 않는다 — 평소 스위트에는 wrapper 도 분기도 남지 않는다. 그래서 커밋에 들어가도
안전하다(이슈 요구사항 2번).

```
MURMUR_TEST_DELAY_MS=80 pnpm --filter @murmur/desktop test
```

늦추는 대상은 **React scheduler 의 macrotask 펌프 둘뿐**이다(`setImmediate`,
`MessageChannel.port2.postMessage`). `setTimeout`/`setInterval` 은 건드리지 않는다 —
그것까지 늦추면 제품의 디바운스·재시도 간격까지 바뀌어 "무엇이 늦어서 깨졌는지"가
흐려진다.

### 가짜 타이머와의 공존

wrapper 는 **매 호출마다** `vi.isFakeTimers()` 를 보고, 참이면 지연 없이 즉시 원래
펌프에 위임한다. 이 확인을 호출 시점에 해야 하는 이유가 있다: vitest 의 `FakeTimers` 는
지연 생성 singleton 이라 **테스트 안에서 처음 `vi.useFakeTimers()` 가 불릴 때** 그
시점의 `global.setImmediate` 를 "되돌릴 원본"으로 캡처한다. 그때 이미 wrapper 가 앉아
있으면 그 wrapper 가 원본으로 캡처되고, sinon 의 `tickAsync` 가 매 스텝마다 wrapper 를
거쳐 실제 `setTimeout(N ms)` 을 기다린다. `advanceTimersByTimeAsync` 가 반복될수록
지연이 누적돼 결국 테스트가 타임아웃으로 죽는다 — `controller.test.ts` 의 `Controller
#267` 두 건에서 이렇게 재현됐다.

### 늦춘 펌프는 환경이 헐린 뒤 깨어날 수 있다

파일의 마지막 렌더가 예약한 펌프가 jsdom 환경 teardown 뒤에 깨어나면 React scheduler
안에서 `window is not defined` 로 터진다. 파일 단위 병렬 실행이라 **매 실행마다 다른
파일에 붙는다**(`messageActions.test.tsx`, `channelPane.test.tsx` … ). 제품 결함이
아니라 주입기가 만든 잔여 타이머다. 깨어날 때 `globalThis.window` 가 아직 있는지 보고
없으면 조용히 버려서 없앴다.

`afterEach` 로 일괄 취소하는 방법은 **쓰면 안 된다** — 테스트 도중 정상 대기 중인
펌프까지 죽어 171 건이 무너진다(실측). pool 을 바꿔 덮는 것도 답이 아니다: 이 저장소는
`pool` 을 설정하지 않으므로 vitest 3 기본값인 **`forks`** 로 돌고, CI(`pnpm test`) 도
같다. `--pool=forks --singleFork` 로 안 보이게 만들면 CI 기본 실행에서는 그대로 남는다.

## 실측 결과 — 이것이 산출물이다

측정 시점 `a6a7820` + 이 브랜치. 107 파일 / 1183 테스트. pool 은 기본값(`forks`), 즉 CI 와 같다.

| 조건 | 결과 |
| --- | --- |
| env 없음 | 107/107 파일, 1183/1183 통과 — 기존과 동일 |
| `MURMUR_TEST_DELAY_MS=80` × 3회 | **3회 모두 전부 통과. 빨간 목록 0건. unhandled 예외 0건** |
| `MURMUR_TEST_DELAY_MS=400` (5배) | 2건 RED — 아래 |

### 400ms 에서 빨개진 목록과 판정

판별식: **예산(`asyncUtilTimeout`)을 올려 초록이 되면 예산 초과, 그래도 빨가면 진짜 결함.**

| 테스트 | 판정 | 근거 |
| --- | --- | --- |
| `mentionClick.test.tsx` — 소유자가 설정으로 가면 에이전트가 선택된 화면이다 | **예산 초과** | `asyncUtilTimeout` 10s 로 올리니 GREEN |
| `savedMessages.test.tsx` — 8. 체크를 누르면 done 으로 바꾸고 행이 탭을 옮긴다 | **예산 초과** | 같음 |

둘 다 기본 예산 1000ms 안에 펌프 몇 홉이 안 들어간 것뿐이고, 기다리는 대상 자체는
올바르다. PR #388(#367) 이 같은 두 테스트를 같은 방식으로 이미 예산 초과로 판별했고
이번 실측도 같은 결론이다.

**즉 80ms 기준 진짜 타이밍 결함은 0건이다.**

## "0건"이 도구가 놀아서 나온 값이 아니라는 근거

0건은 도구가 아무 것도 안 해도 나온다. 그래서 주입기가 실제로 지연을 넣는지를 따로 쟀다.
`#367` 이 고친 `channelMembersUi.test.tsx`(커밋 `ac51a58`)의 단언 한 줄을 고치기 전
동기 형태(`getByRole('alert')`)로 되돌리고:

- 지연 **없이** → 통과. (바로 이래서 이 결함이 CI 까지 샜다)
- `MURMUR_TEST_DELAY_MS=80` → **5회 중 5회 RED**,
  `Unable to find an accessible element with the role "alert"` — `ac51a58` 이 적은 것과 같은 오류.

같은 코드가 지연을 켜야만 빨개지므로 주입기는 실제로 지연을 넣고 있다. 따라서 위의
"0건"은 **"도구가 아무것도 안 했다"가 아니라 "80ms 아래에서는 새로 드러나는 결함이
없다"** 는 뜻이다.

## 한계

- 80ms 는 통과한다고 해서 결함이 없다는 증명이 아니다 — 더 큰 지연에서는 예산 초과와
  진짜 결함이 섞여 나오므로, 새로 도입할 때마다 위 판별식으로 갈라야 한다.
- 늦추는 것은 scheduler 펌프뿐이라 네트워크·타이머 기반 경합은 이 도구로 안 잡힌다.
