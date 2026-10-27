# @harkroom/e2e — 사용자 스토리보드

owner 한 명으로 쓸 때는 안 보이던 경우(권한 차이·처음 쓰는 사람·여러 사람·여러 커뮤니티)를
**여정 데이터**로 적어 두는 곳이다. 여러 러너가 같은 파일을 읽는다.

| 파일 | 뜻 |
|---|---|
| `stories/personas.yaml` | 페르소나 P1~P8(P = 사람 유형). handle 은 시드 계정 이름이고 `e2e-*` 만 쓴다 |
| `stories/J<n>-*.yaml` | 여정 J1~J14(J = 여정). 단계·기대·실패하면 보이는 것·지금 있는 시험·빈칸 |
| `src/stories.ts` | 형식과 동작 어휘(`ACTIONS`). 러너는 이 동작마다 구현을 단다 |
| `test/stories.test.ts` | 형식 검사 — 모르는 동작·페르소나, 없는 시험 파일, `e2e-*` 가 아닌 handle 을 막는다 |

## 러너(`runners` 칸)

| 러너 | 무엇 | 결과를 부르는 이름 |
|---|---|---|
| `api` | server vitest 안에서 `app.inject` 로 여정을 돈다(시험마다 새 DB) | 서버 판정 |
| `browser` | 데스크톱 웹뷰를 브라우저(Playwright)로 띄운다 | **대체(브라우저)** — Tauri 앱 실물이 아니다 |
| `mobile` | `apps/mobile/integration_test` 를 시험 커뮤니티에 돌린다 | 실물(실기기·시험 테넌트) |
| `harness` | #testbed 의 시험 에이전트 회차 | 실물(러너·운영 서버) |
| `manual` | 손 시험 | 실물 |

### 브라우저 러너 돌리기(로컬)

```sh
docker compose -p e2e up -d --build          # 새 서버(이 체크아웃으로 굽는다)
pnpm --filter @harkroom/desktop exec vite build
pnpm --filter @harkroom/e2e exec playwright install chromium
E2E_SERVER=http://127.0.0.1:3400 pnpm --filter @harkroom/e2e e2e:web
docker compose -p e2e down -v                # 치운다 — 시드는 /bootstrap 부터라 새 서버가 필요하다
```

러너가 여정을 실제로 돌리게 되면 그 러너의 PR 에서 여정의 `existing`·`gaps` 칸도 고친다.

## 규칙

- 공개 저장소다. 실명·메일·회사 이름·테넌트 주소·비밀번호를 적지 않는다. 비밀은 러너가 환경으로 받는다.
- 새 동작이 필요하면 `ACTIONS` 에 먼저 더한다 — 모르는 동작은 형식 검사가 막는다.
