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
   `gh pr merge`·`gh api …/pulls/*/merge`·`gh api graphql …mergePullRequest`·`git push … main` 을 막는다.
   readonly(plan) 턴과 인터랙티브 턴은 argv 를 그대로 둔다. 파일(계정 config·워크스페이스 settings)에는 아무것도
   쓰지 않는다 — 파일에 쓰면 같은 계정 풀의 모든 에이전트에 퍼진다.
3. 에이전트가 `<operatorBin> merge <owner/name> <n> --head <sha>` 를 부른다. 래퍼는 브릿지와 같은 소켓으로
   오퍼레이터에 묻는다. 토큰도 임대도 래퍼 프로세스에는 없다.
4. 오퍼레이터가 ① 인자 모양 ② 턴 임대 ③ 서버 `POST /agent/merge-checks`(grant 정확 일치, 그 턴을 띄운 메시지가
   사람 글인지) ④ `gh pr view`(OPEN·draft 아님·head 일치·CLEAN·체크 초록) ⑤ `gh pr merge --squash
   --match-head-commit` ⑥ `POST /agent/merge-results` 순으로 한다. 서버에 닿지 않으면 머지하지 않는다.
5. 서버가 그 턴의 스레드에 시스템 줄을 남긴다(`🔀 owner/repo#N 머지됨 · sha · 권한: handle (래퍼 보고)`). "래퍼
   보고"인 이유: 서버가 GitHub 에서 직접 확인한 것이 아니다.

## 설정

`operator.json` 의 `merge.ghUser` 에 머지에 쓸 gh 계정을 적는다(`gh auth token -u <ghUser>` 로 토큰을 받는다).
없으면 gh 의 활성 계정이다. 활성 계정이 읽기 전용이면 머지는 실패하고 그 실패도 스레드에 남는다.

```json
{ "communities": { "…": { "agents": {} } }, "merge": { "ghUser": "the-merging-account" } }
```

## 한계

- **codex·opencode·kilo·pi 에는 deny/allow 문법이 없다.** 그 하네스에서는 프롬프트의 "머지는 래퍼로만" 지시가
  전부다. 분류기 문제 자체가 claude 의 것이라 1판은 claude 만 규칙을 준다.
- **권한을 준 사람과 오퍼레이터 주인이 다를 수 있다.** member 가 자기 에이전트에 저장소 권한을 주고 그 에이전트가
  다른 사람의 오퍼레이터에 배정되면, 머지는 그 오퍼레이터 주인의 gh 토큰으로 된다. 오퍼레이터는 서버의 소유 사실을
  모르므로 이 판정은 서버 `checkMerge` 에 넣어야 한다(후속). 지금은 사람이 하나라 영향이 없다.
- 머지 판정 조회와 보고가 한 트랜잭션이 아니다. 래퍼는 보고를 한 번만 보내므로 받아들인다.
- 회사·배포 저장소(머지가 곧 배포)는 상시 권한을 주지 않는다. PR 하나짜리 1회용 권한은 후속이다.
