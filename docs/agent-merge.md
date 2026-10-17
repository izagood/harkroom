# 에이전트 머지 권한

에이전트가 PR 을 머지하는 길은 하나다: 오퍼레이터의 `harkroom-operator merge` 래퍼. 권한은 서버 표가 정하고,
러너는 그 턴에만 허용 규칙을 준다.

## 이것은 실수 방지 장치이지 경계가 아니다

머지 권한은 서버 표(`account_grant` 의 `repo.merge`)와 래퍼가 지키는 **실수 방지 장치**다. 같은 사용자 계정으로
도는 에이전트는 Keychain 의 gh 토큰으로 이 장치를 돌아갈 수 있으므로, 악의적인 에이전트를 막는 경계가 아니다.
경계가 필요해지면 seatbelt 격리나 서버 머지(GitHub App + ruleset)로 간다.

## 흐름

1. 소유자(사람)가 설정 › 에이전트에서 `repo.merge` 를 저장소 단위로 준다. scope 는 `repo:<owner>/<name>` 하나뿐이고
   전역은 없다. admin 역할은 거두기만 한다.
2. 러너가 멘션 턴을 띄울 때 `GET /agent/merge-grants` 를 읽는다. 저장소가 하나라도 있으면 claude 에
   `--allowedTools "Bash(<operatorBin> merge:*)"` 를 준다. 모든 auto 멘션 턴에는 `--disallowedTools` 로
   `gh pr merge:*`·`gh api -X PUT:*`·`gh api --method PUT:*`·`git push origin main`(과 `HEAD:main`·`-u`·`--force` 꼴)을
   막는다. 규칙 문법은 접두(`:*`) 아니면 정확 일치뿐이라(실측) 가운데 와일드카드로는 아무것도 못 막는다 — `gh api
   graphql` 뮤테이션과 그 밖의 push 꼴은 분류기에 남는다.
   readonly(plan) 턴과 인터랙티브 턴은 argv 를 그대로 둔다. 파일(계정 config·워크스페이스 settings)에는 아무것도
   쓰지 않는다 — 파일에 쓰면 같은 계정 풀의 모든 에이전트에 퍼진다.
3. 에이전트가 `<operatorBin> merge <owner/name> <n> --head <sha>` 를 부른다. 래퍼는 브릿지와 같은 소켓으로
   오퍼레이터에 묻는다. 토큰도 임대도 래퍼 프로세스에는 없다. `--approval` 같은 승인 id 는 받지 않는다 — 승인 근거는
   서버가 그 턴을 띄운 메시지로 판정한다.
4. 오퍼레이터가 ① 인자 모양 ② 턴 임대 ③ 서버 `POST /agent/merge-checks`(grant 정확 일치 또는 조직 grant `owner/*`, 그 턴을 띄운 메시지가
   사람 글인지) ④ `gh pr view`(OPEN·draft 아님·head 일치·CLEAN·체크 초록 — `UNSTABLE` 이면 필수 체크만, 아래) ⑤ `gh pr merge --squash
   --match-head-commit`(대상 브랜치가 merge queue 를 쓰면 대신 큐에 넣는다 — 아래) ⑥ `POST /agent/merge-results` 순으로 한다.
   서버에 닿지 않으면 머지하지 않는다.
5. 서버가 그 턴의 스레드에 시스템 줄을 남긴다(`🔀 owner/repo#N 머지됨 · sha · 권한: handle (래퍼 보고)`). "래퍼
   보고"인 이유: 서버가 GitHub 에서 직접 확인한 것이 아니다.

## 설정

머지에 쓸 gh 계정은 `operator.json` 의 `merge.ghUser` 다(`gh auth token -u <ghUser>` 로 토큰을 받는다). 앱의
설정 › 에이전트 › 상세의 머지 절에서 「머지에 쓸 GitHub 계정」으로 고른다 — 그 에이전트가 이 기기에 배정돼 있고
보는 사람이 소유자일 때 보인다. 목록은 이 기기 gh 에 로그인된 계정이고(`gh auth status --json hosts`, 토큰은 읽지
않는다), 오퍼레이터는 그 순간 목록에 있는 이름만 받는다. 처음 값은 비어 있고 저절로 정해지지 않는다. 바꾸면
오퍼레이터 로그에 한 줄 남는다. 손으로 적어도 된다.
**없으면 래퍼는 머지하지 않는다**(`no_gh_user`). gh 의 활성 계정으로 넘어가지 않는 이유: 활성 계정이 무엇이든 그
신원으로 머지되고, 서버는 저장소 이름을 가리지 않는다. 이 머신의 활성 계정은 회사 계정이라 회사 저장소에 쓰기 권한이
있다. `ghUser` 를 개인 계정으로 고정하면 그 계정이 쓸 수 없는 저장소(회사 저장소)는 래퍼로 머지할 수 없다 — "회사
저장소는 상시 권한 없음"을 기계로 지키는 자리가 이 칸이다.

```json
{ "communities": { "…": { "agents": {} } }, "merge": { "ghUser": "the-merging-account" } }
```

## 거절 카드 [7일 주기]

판정이 `not_granted` 이고 **나머지 판정은 통과**(임대·저장소 이름·그 턴을 띄운 것이 사람)하면 서버가 거절 기록(`merge_denial`)을
남기고 `merge-checks` 의 403 본문에 `denialId` 를 싣는다. 에이전트가 `message.ask` 에 `mergeDenialId` 로 그것을 실으면 서버가
기록에서 저장소·PR·에이전트 칸을 채운 카드를 세운다(에이전트 본문과 따로). 같은 날 같은 저장소·스레드면 새 카드 대신 횟수가 오른다.

- 버튼은 ask 선택지가 아니다. `POST /agents/:id/merge-denials/:denialId/grant` — 사람 **세션**만(PAT·에이전트 토큰 403), 그
  에이전트의 소유자만, `:id` 가 기록의 에이전트와 같아야 하고, 기록은 한 번만 쓴다. scope·기한은 본문에서 받지 않는다(기록과 7일).
- 새 카드는 **권한 요청 카드**로 선다(P4). 소유자는 [승인하고 다시 시도](그 저장소 7일 grant) 또는 **[이번 한 번 머지]**
  (`POST /agents/:id/permission-requests/:rid/approve-once`, 본문 `ghUser`·`relaxChecks` 뿐)를 고른다. 1회 승인은 거절 기록의
  (PR, head, 스레드)에 묶이고 24시간 안에 한 번만 쓰인다 — `checkMerge` 가 임대·저장소 모양을 본 뒤 grant·사람 턴 판정 대신 이것을
  소모한다. `cause_not_human` 거절도 카드가 선다. 래퍼는 소모 전에 기록의 계정·head 로 읽기 전용 사전 확인을 하고, 승인 계정만 쓴다.
- 배포 저장소라고 따로 막지 않는다(jaebin 10-10) — 모든 저장소가 같은 규칙이다. 배포 저장소의 안전장치는 GitHub 쪽에 둔다.
- **조직 grant `owner/*`**(10-09): 설정 화면에서 소유자가 `owner/*` 로 주면 그 owner 의 저장소 전부(앞으로 생길 것 포함)에 맞는다.
  `*` 는 저장소 자리 전체에만 온다 — `*`·`*/*`·owner 자리의 `*`·`owner/ab*` 는 400. `permission.request` 로는 청하지 못한다(`org_wide`) — 승인 한 번에 조직이 통째로 열리지 않게.
  래퍼·판정의 **실제 저장소** 자리는 여전히 `owner/name` 하나다(`repoScope`), grant 를 주고 거두는 자리만 `repoGrantScope`.
- 주고 나서 소유자가 같은 카드에서 「다시 머지」를 고르면 F4(소유자가 에이전트 자신의 카드에 답함)로 새 턴이 뜬다.
- 범위 밖: 같은 uid 로 도는 에이전트가 사람의 세션 토큰을 읽어 이 REST 를 부르는 경우(G2 위협 모델과 같다).
- 거절 기록은 늘지 않게 묶는다: 같은 (에이전트, 저장소, 스레드)에 안 쓴 기록이 있으면 그것을 다시 쓰고(PR·head 만 바꾼다),
  새 기록은 에이전트마다 24시간에 20개까지다. 넘으면 `not_granted` 는 그대로이고 `denialId` 만 없다.
- 래퍼는 `denialId` 를 에이전트 답의 `error.denialId` 로 그대로 넘긴다(uuid 모양일 때만). 프롬프트가 "그 값을 `mergeDenialId` 로
  실어 카드를 세워라, `to`·`mirrorOf` 는 싣지 마라"를 지시한다.

## CI 실패 무시 1회 승인

CI 오류를 고치는 PR 처럼 CI 가 빨간 채로 머지해야 할 때가 있다. 기본은 그대로 「CI 초록」이다(초록의 기준은 아래 `UNSTABLE` 절 —
저장소의 required 집합을 따르므로, required 를 하찮은 체크 하나로만 두면 그만큼 느슨해진다. 이것은 저장소 정책의 몫이다).
소유자가 명시적으로 승인하면 **그 PR·그 head 한 번만** CI 조건 없이 머지한다.

- 7일 grant 가 있어도 래퍼가 `ci_not_green`, 또는 `not_mergeable` + `UNSTABLE` 로 거절하면 실패 보고(`/agent/merge-results`)에
  `ciRefusal{code, mergeState, checks}` 를 싣는다. 서버는 **같은 임대로 판정을 통과한 그 repo·PR·head** 의 보고에서만 거절 기록
  (reason `ci_not_green`, 실패 체크 이름)을 남기고 `denialId` 를 돌려준다. 묶음·하루 상한은 위 거절 기록과 같다(CI 기록끼리만 다시 쓴다).
  체크 이름은 서버가 다시 거른다 — 제어·서식(bidi 포함) 문자를 빼고, 이름당 80자·20개까지.
- 카드는 [이번 한 번 머지] 하나다. 서버가 막는다: 이 기록으로는 7일 grant 를 만들 수 없고(400 `ci_card_once_only`, 두 길 다),
  `relaxChecks:false` 승인도 받지 않는다(400 `relax_required`). 승인은 사람 세션·소유자만, 카드가 보여 준 PR·head 가 다르면 409 `card_stale`.
- **쓰는 턴도 사람이 띄운 것**이어야 한다(`merge_approval.ci_override`) — 사람 글, 또는 소유자가 에이전트의 카드에 답한 턴. wake·에이전트
  위임 턴에서는 판정도 peek 도 이 승인을 고르지 않는다(남는다).
- 승인을 쓴 순간 「🔓 … CI 실패 무시 승인으로 머지 시도 · 승인: handle」 줄이 선다. 머지 보고에는 래퍼가 그때 다시 읽은 초록 아닌
  체크 이름(`ignoredChecks`)을 싣고, 줄에 「· CI 실패 무시 승인 · 무시: …」, 승인 때 본 목록보다 늘었으면 「(승인 뒤 늘어남)」을 붙인다.
  감사(`repo.merge.merged`)에는 approvalId·approvedBy·이름 목록이 남는다.
- **CI 를 건너뛰는 승인은 CI 만 건너뛴다**(relaxChecks — 이 카드와 기존 카드의 「체크 판정은 GitHub 에 맡기기」 둘 다): `mergeStateStatus` 가
  CLEAN·UNSTABLE·HAS_HOOKS 일 때만 지나가고, DIRTY(충돌)·BEHIND·UNKNOWN·BLOCKED(리뷰 필수 같은 브랜치 보호)·draft 는 승인이 있어도 래퍼가
  거절한다. 이 거절은 승인을 쓰기 **전** 사전 확인에서 나므로 승인은 남고 거절 기록도 생기지 않는다. 필수 체크 빨강 때문에 생긴 BLOCKED 를
  가려 푸는 것은 다음 단계로 따로 설계한다.
- 카드: 제목 「CI 실패 무시하고 이번 한 번 머지」, 실패 체크 이름(앱이 한 번 더 거르고 텍스트로만), PR 링크·head 9자. 체크박스·7일 버튼이 없다.
- 승인 없이 비필수 체크를 무시하고 머지한 경우(`UNSTABLE`, 필수 체크 초록)도 같은 `ignoredChecks` 로 줄·감사에 이름이 남는다.

## merge queue

### `UNSTABLE` — 필수가 아닌 체크가 실패한 PR

GitHub 의 `mergeStateStatus: UNSTABLE` 은 「초록이 아닌 체크가 있지만 필수 체크는 통과해 머지할 수 있다」는 뜻이다. 래퍼의
「CI 초록」 규칙은 이때 **필수 체크**에 건다. ④ 에서 `UNSTABLE` 이면 GraphQL 로 head 커밋의 체크마다
`isRequired(pullRequestNumber:)`(브랜치 보호와 ruleset 의 required status checks 를 둘 다 반영한다)를 읽는다(읽기 전용).

- 필수 체크가 하나 이상 있고 **전부 초록**이면 통과한다. 초록이 아닌 비필수 체크 이름은 결과 JSON `ignoredChecks` 에 싣는다.
  이름별 판정(같은 이름에 빨강이 하나라도 있으면 빨강)은 그대로다.
- **필수 체크가 하나도 없는 저장소는 통과시키지 않는다** — 그러면 Test 가 빨개도 머지되는 길이 된다. 지금처럼 모든 체크가
  초록이어야 하고, `ci_not_green` 문구에 실패한 이름과 「꼭 통과해야 할 체크를 required 로 정하라」를 싣는다. 실패해도 되는
  체크(봇 리뷰 등)가 있는 저장소는 Lint·Test 같은 체크를 브랜치 보호나 ruleset 의 required status checks 로 정하면 된다.
- 필수 체크가 초록이 아니면 `ci_not_green`(`required checks not green: …`). 조회가 실패하거나 모양이 틀리면 원래대로
  `not_mergeable`(fail-closed), 조회한 커밋이 `--head` 와 다르면 `head_moved`, 체크가 100개를 넘으면 판정하지 않는다.
- `BLOCKED`·`DIRTY` 등 다른 상태는 지금처럼 `not_mergeable` 이고, 문구에 초록이 아닌 체크 이름을 더한다.
- 실측(10-16, 시험 저장소, 래퍼 본체 + 모의 서버): 필수 체크 없음 + 실패 체크 1개 → `ci_not_green`(문구에 이름), ruleset 으로
  다른 체크를 required 로 정한 뒤 → 큐에 넣음·`ignoredChecks: ["review"]`.

대상 브랜치가 merge queue 를 쓰면 GitHub 은 `gh pr merge --squash` 를 거절한다(머지 전략은 큐가 정하고, auto-merge 가 꺼진
저장소에서는 `--auto` 도 안 된다). 래퍼는 ⑤ 에서 GraphQL `pullRequest.isMergeQueueEnabled` 를 읽고, 켜져 있으면
`enqueuePullRequest(pullRequestId, expectedHeadOid = --head)` 로 **큐에 넣는다**. `jump`(맨 앞으로)는 쓰지 않는다.

- ①~④ 관문(인자·임대·서버 판정·OPEN·head 일치·CLEAN·CI 초록, 1회 승인의 사전 확인)은 큐에 넣기 **전에** 똑같이 건다.
  큐에 넣는 길은 squash 머지와 같은 자리(⑤)에서만 갈린다.
- 결과: `{ merged: false, queued: true, alreadyQueued: false, queue: { position, state } }`. 서버 보고는 `result: "queued"` 이고
  스레드에 `📥 owner/repo#N 머지 큐에 넣음 · head … · 권한: handle (래퍼 보고)` 줄이 선다(감사 `repo.merge.queued`). 「머지됨」 줄은
  쓰지 않고 기다리던 머지 카드도 닫지 않는다 — 큐가 실제로 머지했는지는 이 보고가 말하지 않는다.
- **큐가 머지할 때까지 기다리지 않는다. 확인은 같은 명령을 다시 부르는 것이다.** 아직 큐에 있으면 `alreadyQueued: true`
  (오류 아님, 아무것도 하지 않고 보고도 없다), 큐가 머지했으면 `not_open`(pr.state `MERGED`). 큐가 PR 을 빼냈으면(OPEN·큐에 없음)
  다시 부르는 것은 새 머지 요청이다 — 관문을 처음부터 다시 지난다. 이미 MERGED·CLOSED 인 PR 에는 「⛔ 머지 실패」 줄을 쓰지 않고
  기다리던 카드만 닫는다(`merge-closed`).
- 실측(10-16, 시험 저장소, 래퍼 본체 + 모의 서버): 큐 브랜치의 ready PR 은 `CLEAN` 으로 온다. 큐에 든 PR 에 다시 넣으면 GitHub 은
  `Pull request is already in the queue`(UNPROCESSABLE), head 가 바뀐 뒤 옛 head 로 넣으면 `expected head oid does not match the current head oid` 로 거절한다.
- 이미 큐에 있는 PR 은 어느 길에서든 읽기 전용으로 알아보고 끝낸다: 1회 승인 사전 확인(승인을 쓰지 않는다), 권한 거절
  (`not_granted`·`cause_not_human` — 카드를 세우지 않는다), 판정 통과(다시 넣지 않는다). 넣는 사이 다른 쪽이 먼저 넣었다는
  GitHub 오류도 `alreadyQueued` 로 돌려준다.
- 큐 브랜치에서는 머지 방식(squash·merge·rebase)과 묶음을 **큐 설정이 정한다** — 래퍼의 「squash 로만」 불변식은 그 브랜치에선
  큐 설정(ruleset)의 몫으로 넘어간다. 큐를 켤 때 squash 로 맞춰 둔다.
- 「이미 큐에 있음」은 head 대조보다 먼저 나오므로 결과에 PR 의 지금 head(`prHeadRefOid`)를 같이 싣고, `--head` 와 다르면 note 에 적는다.
  1회 승인이 소모된 뒤 경합으로 이 답이 나오면 note 에 `the one-time approval was used` 가 붙는다. enqueue 가 「이미 큐」 문구로
  실패해도 다시 읽어 정말 큐에 있을 때만 이 답이고, 아니면 `enqueue_failed` 다.
- 큐 정보를 읽지 못하면(GraphQL 실패) 지금처럼 squash 를 시도한다 — 큐 브랜치라면 GitHub 이 거절하고 `merge_failed` 가 된다.
- 옛 서버(`queued` 를 모르는 판)는 보고를 400 으로 거절한다 — 큐에는 들어갔고 시스템 줄만 없다(오퍼레이터 로그에 남는다).

## 래퍼 결과·오류 코드

성공이면 `merged` 또는 `queued` 가 `true` 다. 거절·실패는 `error.code` 하나로 갈린다.

| 결과 / `error.code` | 뜻 | 에이전트가 할 일 |
|---|---|---|
| `merged: true` | squash 머지됨, 시스템 줄 `🔀 … 머지됨` | 머지됐다고 보고 |
| `queued: true`, `alreadyQueued: false` | merge queue 에 넣음, 시스템 줄 `📥 … 큐에 넣음` | 「큐에 넣음」으로 보고, 확인은 같은 명령 |
| `queued: true`, `alreadyQueued: true` | 이미 큐에 있다 — 아무것도 안 함 | 기다리거나 나중에 같은 명령 |
| `bad_request` | 인자 모양이 틀림 | 명령을 고친다 |
| `no_lease` | 이 턴에 임대가 없다(권한 아님, 턴 임대가 오퍼레이터에 없다) | 사람에게 넘긴다 |
| `unavailable` | 서버에 닿지 않음 — fail-closed | 나중에 다시 |
| `not_granted`·`cause_not_human` (+`denialId`) | 권한 없음 / 사람 글이 띄운 턴이 아님 | `denialId` 가 있으면 `message.ask` `mergeDenialId` 카드 |
| `approval_mismatch` | 서버가 쓴 1회 승인이 사전 확인한 것과 다름 | 다시 승인받는다 |
| `no_gh_user`·`gh_user_not_logged_in`·`gh_token_failed` | 이 기기에서 그 저장소에 쓸 gh 계정이 없음/로그인 안 됨 | 사람에게 넘긴다 |
| `no_repo_access` | 그 gh 계정이 저장소에 닿지 못함 | 「사람이 머지」 |
| `pr_not_found` | `gh pr view` 실패 | 번호·저장소 확인 |
| `not_open`·`draft`·`head_moved`·`not_mergeable`·`ci_not_green` | PR 상태 관문 | 원인을 고치거나 사람에게 |
| `merge_failed` | `gh pr merge` 실패 | 오류를 적어 사람에게 |
| `enqueue_failed` | `enqueuePullRequest` 실패(이미 큐에 있음 제외) | 오류를 적어 사람에게 |
| `merge_error` | 래퍼 내부 오류 | 사람에게 |

오류 문구 끝의 `the one-time approval was not used` 는 1회 승인이 남았다는 뜻이고, `approve again` 은 이미 쓰였다는 뜻이다.

## 「사람이 머지」 (`no_repo_access`)

판정은 통과했는데 `merge.ghUser` 계정이 그 저장소에 닿지 못하면(`gh pr view`·`gh pr merge` 가 저장소 접근 오류) 래퍼는
`no_repo_access` 로 답한다. 권한을 더 줘도 풀리지 않으므로 카드를 세우지 않고, 에이전트는 PR 번호·head sha 를 적어 사람에게
넘긴다. gh 오류 원문은 서버 보고(`merge-results` 의 `error`, 시스템 줄 meta)에만 남고 에이전트 답에는 싣지 않는다.

## 한계

- **codex·opencode·kilo·pi 에는 deny/allow 문법이 없다.** 그 하네스에서는 프롬프트의 "머지는 래퍼로만" 지시가
  전부다. 분류기 문제 자체가 claude 의 것이라 1판은 claude 만 규칙을 준다.
- **권한을 준 사람과 오퍼레이터 주인이 다를 수 있다.** member 가 자기 에이전트에 저장소 권한을 주고 그 에이전트가
  다른 사람의 오퍼레이터에 배정되면, 머지는 그 오퍼레이터 주인의 gh 토큰으로 된다. 오퍼레이터는 서버의 소유 사실을
  모르므로 이 판정은 서버 `checkMerge` 에 넣어야 한다(후속). 지금은 사람이 하나라 영향이 없다.
- 머지 판정 조회와 보고가 한 트랜잭션이 아니다. 래퍼는 보고를 한 번만 보내므로 받아들인다.
