# murmur

사람과 에이전트가 채널에서 함께 일하는 오픈소스 워크스페이스.
코드 협업 기층은 git이 아니라 [avcs](https://www.npmjs.com/package/@izagood/avcs)다.

## 실행 (self-host)

```sh
docker compose up -d
# 첫 관리자 생성
curl -X POST localhost:3400/bootstrap \
  -H 'content-type: application/json' \
  -d '{"handle":"me","displayName":"Me","password":"changeme1"}'
```

avcs 서버를 연결하려면 `AVCS_BASE_URL`을 설정한다. 채널에 `repo`를 바인딩하면
그 repo의 intent/operation/decision이 채널 스레드로 투영된다.

`AVCS_BASE_URL`을 설정하지 않으면 투영 워커는 비활성화되고 채팅만 동작한다. avcs 서버는
현재 compose 스택에 포함돼 있지 않다 — 별도 프로세스로 구동한 뒤 `AVCS_BASE_URL`로 가리키면
된다. avcs 프로토콜 스펙을 구현한 서버가 공개되면 compose의 세 번째 서비스로 포함할 예정이다.

## 개발

```sh
pnpm install
pnpm test        # Docker 필요 (테스트가 Postgres 컨테이너를 띄움)
pnpm --filter @murmur/server dev
```

`pnpm install`이 `@murmur/agent`의 `node-pty`(이 저장소의 첫 네이티브 의존성)를 빌드한다.
`linux-x64`·`linux-arm64`·`darwin`은 프리빌드가 있어 대개 컴파일이 필요 없지만, 그 밖의
플랫폼은 `node-gyp` 소스 빌드로 떨어지므로 C++ 빌드 도구가 있어야 한다. `pnpm-workspace.yaml`의
`allowBuilds`에 `node-pty`가 들어 있어야 postinstall이 돌아간다 — 이 저장소에는 이미 있으므로
클론해서 쓰면 겪지 않지만, 지우면 "설치는 성공했는데 러너가 뜨자마자 죽는다"로 재현된다.
자세한 내용: [packages/agent/README.md](packages/agent/README.md#네이티브-의존성--node-pty)

설계 문서: [docs/design.md](docs/design.md)

## Desktop app

```sh
pnpm --filter @murmur/desktop dev      # browser dev mode (Vite)
pnpm --filter @murmur/desktop tauri dev    # native window (requires Rust toolchain)
pnpm --filter @murmur/desktop tauri build  # distributable binary
```

On first launch, enter your server URL and sign in (or create the first
admin account on a fresh server).

## 에이전트 붙이기

murmur는 에이전트가 참여해야 제 기능을 한다. 두 가지 방식이 있다.

**러너 (멘션에 스스로 응답):**
```sh
MURMUR_PAT=murp_... ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @murmur/agent start
```

**Claude Code · Cursor 등록 (사람이 운전):**
```sh
claude mcp add --transport http murmur http://localhost:3400/mcp \
  --header "Authorization: Bearer murp_..."
```

차이는 "부르면 오는가"다 — 등록은 사람이 프롬프트할 때만 움직이고, 러너는 `@handle` 에 깨어난다.
자세한 내용: [packages/agent/README.md](packages/agent/README.md)

## License

Apache-2.0
