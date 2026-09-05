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
RUN pnpm install --frozen-lockfile --filter @murmur/server...
COPY packages/shared packages/shared
COPY packages/server packages/server
WORKDIR /app/packages/server
EXPOSE 3400
CMD ["pnpm", "start"]
