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
4. 오퍼레이터가 ① 인자 모양 ② 턴 임대 ③ 서버 `POST /agent/merge-checks`(grant 정확 일치, 그 턴을 띄운 메시지가
   사람 글인지) ④ `gh pr view`(OPEN·draft 아님·head 일치·CLEAN·체크 초록) ⑤ `gh pr merge --squash
   --match-head-commit` ⑥ `POST /agent/merge-results` 순으로 한다. 서버에 닿지 않으면 머지하지 않는다.
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
- 배포 저장소(`HARKROOM_MERGE_DEPLOY_REPOS`)는 카드에서 주지 않는다 — 설정 화면에서 정확한 이름으로 준다.
- 주고 나서 소유자가 같은 카드에서 「다시 머지」를 고르면 F4(소유자가 에이전트 자신의 카드에 답함)로 새 턴이 뜬다.
- 범위 밖: 같은 uid 로 도는 에이전트가 사람의 세션 토큰을 읽어 이 REST 를 부르는 경우(G2 위협 모델과 같다).

## 한계

- **codex·opencode·kilo·pi 에는 deny/allow 문법이 없다.** 그 하네스에서는 프롬프트의 "머지는 래퍼로만" 지시가
  전부다. 분류기 문제 자체가 claude 의 것이라 1판은 claude 만 규칙을 준다.
- **권한을 준 사람과 오퍼레이터 주인이 다를 수 있다.** member 가 자기 에이전트에 저장소 권한을 주고 그 에이전트가
  다른 사람의 오퍼레이터에 배정되면, 머지는 그 오퍼레이터 주인의 gh 토큰으로 된다. 오퍼레이터는 서버의 소유 사실을
  모르므로 이 판정은 서버 `checkMerge` 에 넣어야 한다(후속). 지금은 사람이 하나라 영향이 없다.
- 머지 판정 조회와 보고가 한 트랜잭션이 아니다. 래퍼는 보고를 한 번만 보내므로 받아들인다.
- 회사·배포 저장소(머지가 곧 배포)는 상시 권한을 주지 않는다. PR 하나짜리 1회용 권한은 후속이다.
