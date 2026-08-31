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

설계 문서: [docs/design.md](docs/design.md)

## Desktop app

```sh
pnpm --filter @murmur/desktop dev      # browser dev mode (Vite)
pnpm --filter @murmur/desktop tauri dev    # native window (requires Rust toolchain)
pnpm --filter @murmur/desktop tauri build  # distributable binary
```

On first launch, enter your server URL and sign in (or create the first
admin account on a fresh server).

## License

Apache-2.0
