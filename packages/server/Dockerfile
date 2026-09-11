FROM node:22-alpine
WORKDIR /app
RUN corepack enable
# 락파일을 함께 복사한다 — **없으면 `--frozen-lockfile` 자체가 불가능하다.**
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
# 락파일이 지정한 버전 그대로 설치한다.
#
# 예전에는 `--frozen-lockfile=false` 였다 — 위 `COPY` 에 `pnpm-lock.yaml` 이 없어
# 락파일 없이 설치해야 했기 때문이다. 그 결과 **컨테이너가 호스트·CI 와 다른 버전으로
# 갈렸다**: 락파일이 `fastify@5.12.1` 을 지정하는데 컨테이너는 `5.12.3` 을 받았다
# (2026-09-06 실측). 패치 차이라 당장은 무해했지만, 언젠가 그 차이가 문제를 낼 때
# **CI 는 통과하는데 컨테이너만 이상한** 상황이 되고 원인이 빌드에서 멀어진다.
#
# `--filter` 로 서버와 그 의존만 설치한다 — 워크스페이스 전체를 복사하지 않으므로
# 다른 패키지(desktop·agent·daemon)의 의존까지 받을 이유가 없다.
RUN pnpm install --frozen-lockfile --filter @harkroom/server...
COPY packages/shared packages/shared
COPY packages/server packages/server
# 릴리스 버전의 **정본**이다(`packages/server/src/version.ts` 에 근거). 서버가 `/healthz` 에
# 자기 버전을 실으려면 이 한 파일이 이미지 안에 있어야 한다 — 몇 백 바이트짜리 JSON 이고
# `packages/desktop` 의 나머지는 들어오지 않는다.
COPY packages/desktop/src-tauri/tauri.conf.json packages/desktop/src-tauri/
WORKDIR /app/packages/server

# **맨 끝에 둔다.** `ARG` 는 그 아래 모든 레이어의 캐시를 무효화하므로, 위쪽(`pnpm install`)에
# 두면 커밋이 바뀔 때마다 의존을 통째로 다시 받는다 — 재배포가 1분에서 5분이 된다.
#
# `.git` 은 빌드 컨텍스트에서 빠져 있어(`.dockerignore`) 이미지가 스스로 sha 를 알 수 없다.
# 그래서 빌드하는 쪽이 심어 준다:
#   MURMUR_COMMIT=$(git rev-parse --short HEAD) docker compose -p narwhal build server
# 안 심으면 `null` 로 말한다 — 빌드는 그대로 된다(docs/operations.md).
ARG MURMUR_COMMIT=""
ENV MURMUR_COMMIT=$MURMUR_COMMIT

EXPOSE 3400
CMD ["pnpm", "start"]
