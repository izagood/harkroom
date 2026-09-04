# Codex harness 활성화 계획과 검증 기록

## 목표

Murmur 에이전트 정의에서 `codex`를 선택해 멘션으로 작업을 맡길 수 있고, 같은 하네스 세션의
터미널을 직접 열어 사람과 Codex가 함께 작업할 수 있게 한다. 이 문서는 #108의 구현 범위와
활성화 기준을 기록한다.

## 구현 전 실측

2026-09-04, `codex-cli 0.153.2`로 다음을 확인했다.

- `codex exec` 첫 턴 뒤 `codex exec resume <id>` 두 턴이 같은 세션 id로 이어졌고 이전 턴의
  표식을 기억했다.
- `codex resume` 도움말에는 `--ignore-user-config`가 보이지만 실제 파서는 그 플래그를
  거부했다. 따라서 개인 `~/.codex/config.toml`을 상속한 채 대화형 터미널을 여는 것은
  허용하지 않는다.
- 별도 `CODEX_HOME`을 만들고 기존 `auth.json`만 링크하면 개인 MCP 설정은 사라지는 동시에
  로그인과 대화형 resume은 정상 동작했다.
- Codex의 저장소 범위 스킬 경로는 공식 문서 기준 `.agents/skills`다. 기존
  `.codex/skills` 링크는 실제 로딩 경로가 아니었다.

## 구현

1. `RUNNABLE_HARNESSES`에 `codex`를 추가해 서버 API와 데스크탑 선택지를 함께 연다.
2. 러너별 상태 디렉터리 아래 `codex-home`을 만들고 자식 Codex 프로세스에만 `CODEX_HOME`으로
   전달한다. 개인 인증은 링크하되 config·sessions·logs는 러너별로 격리한다.
3. 멘션 턴은 기존 `codex exec`/`codex exec resume`과 sandbox·MCP 턴별 오버라이드를 유지한다.
4. 직접 터미널은 첫 턴 `codex`, 이후 `codex resume <id>`로 열고 같은 격리 홈의 rollout에서
   첫 세션 id를 발견한다.
5. 승인 스킬의 Codex 링크를 `.agents/skills`로 수정한다.

## 수용 기준

- 첫 멘션과 resume 멘션이 같은 세션을 사용한다.
- 세션이 없는 스레드에서 Codex 터미널이 열리고, 종료 후 발견한 id로 다시 resume된다.
- Codex 자식 env에는 격리 `CODEX_HOME`이 있고 개인 config.toml은 그 홈에 복사되지 않는다.
- 멘션·대화형 양쪽 모두 Murmur/AVCS MCP 오버라이드를 받으며 PAT는 argv에 나타나지 않는다.
- 조립된 네 가지 Codex CLI 형태(멘션 첫 턴/resume, 대화형 첫 턴/resume)가 실제 CLI 파서를
  통과한다.
- 전체 workspace typecheck와 테스트, GitHub CI가 통과한 뒤에만 merge한다.
