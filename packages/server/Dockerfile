# 서버 이미지. **두 스테이지**이고, 왜 나눴는지가 이 파일의 요점이다.
#
# ## 왜 한 스테이지면 안 되는가 (2026-09-12)
#
# 예전에는 한 스테이지에서 `pnpm install --filter @harkroom/server...` 를 돌렸다. 그 명령은
# devDependencies 까지 받는다 — `vitest`·`@testcontainers/postgresql`·`typescript`·
# `@izagood/avcs-server` 가 **돌아가는 서버 이미지 안에** 들어 있었다. 자기 기계에서 compose
# 로 빌드해 쓰는 동안에는 티가 안 났지만, 이 이미지를 ghcr 로 공개하는 순간 그것은 남의
# 클러스터에 배포되는 것들이 된다. 쓰지 않는 의존은 기능에는 영향이 없고 **취약점 보고서와
# 전송 바이트에만** 남는다.
#
# 그래서 설치(그리고 네이티브 애드온 컴파일)는 `deps` 에서 하고, 런타임 이미지에는 prod
# 의존과 소스만 넘어온다.

# ─────────────────────────────────────────────────────────────────────────────
# 1) deps — 의존을 설치한다(이 스테이지는 배포되지 않는다)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable

# `argon2` 는 네이티브 애드온이다. alpine 은 musl 이라 prebuild 가 맞지 않는 아키텍처에서는
# 여기서 소스로 컴파일한다 — **멀티아치 빌드의 전제다.** 이 도구들은 런타임 스테이지로
# 넘어가지 않으므로 배포 이미지는 그대로 얇다.
RUN apk add --no-cache python3 make g++

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
#
# `--prod` 가 위 "두 스테이지" 절의 실행이다. 런타임이 `tsx` 로 TS 소스를 그대로 돌리므로
# **`tsx` 는 `packages/server/package.json` 의 `dependencies` 에 있다** — 그것이 이 서버의
# 프로덕션 런타임이기 때문이고(`start` 스크립트가 그것을 부른다), devDependency 로 두면
# 이 줄이 그것을 빼 버려 이미지가 뜨지 않는다.
RUN pnpm install --frozen-lockfile --prod --filter @harkroom/server...

# ─────────────────────────────────────────────────────────────────────────────
# 2) runtime — 실제로 배포되는 이미지
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# 설치 결과를 **통째로** 가져온다. pnpm 은 실제 패키지를 루트 `node_modules/.pnpm/` 에 두고
# 각 패키지에는 거기로 가는 상대 심링크만 건다. 패키지 것만 가져오면 가리키는 곳이 없는
# 심링크가 되어 `ERR_MODULE_NOT_FOUND` 로 죽는다 — `.dockerignore` 상단에 적힌 그 함정과
# 같은 것이다.
COPY --from=deps /app ./

COPY packages/shared packages/shared
COPY packages/server packages/server
# 릴리스 버전의 **정본**이다(`packages/server/src/version.ts` 에 근거). 서버가 `/healthz` 에
# 자기 버전을 실으려면 이 한 파일이 이미지 안에 있어야 한다 — 몇 백 바이트짜리 JSON 이고
# `packages/desktop` 의 나머지는 들어오지 않는다.
COPY packages/desktop/src-tauri/tauri.conf.json packages/desktop/src-tauri/

# 첨부 디렉터리를 **이미지 안에 미리 만들고 uid 1000 에게 준다.** 이미지에 없는 경로에
# 볼륨을 붙이면 도커는 그 디렉터리를 root 소유로 만들고, 아래에서 uid 1000 으로 내려앉은
# 프로세스는 거기에 한 바이트도 쓰지 못한다(k8s 에서는 `fsGroup` 이 같은 일을 한다).
RUN mkdir -p /var/lib/harkroom/attachments && chown -R 1000:1000 /var/lib/harkroom

# 기본값을 **이미지가 안다.** compose 가 넣어 주던 값들이라, 이미지를 직접 쓰는 쪽(k8s·
# `docker run`)은 README 를 읽어야만 알 수 있었다.
#
# `PATH` 에 `.bin` 을 얹는 것은 아래 `CMD` 를 위한 것이다.
ENV ATTACHMENT_ROOT=/var/lib/harkroom/attachments \
    PORT=3400 \
    PATH=/app/packages/server/node_modules/.bin:$PATH

WORKDIR /app/packages/server

# **숫자로 적는다.** node 이미지에는 `node`(uid 1000) 계정이 있어 `USER node` 로도 되지만,
# k8s 의 `runAsNonRoot: true` 는 이미지의 USER 가 이름이면 "container has runAsNonRoot and
# image has non-numeric user" 로 **파드를 아예 안 띄운다** — kubelet 은 이름을 uid 로 풀어
# 볼 방법이 없기 때문이다. 숫자로 적으면 그 정책 아래에서 그냥 뜬다.
USER 1000:1000

# **맨 끝에 둔다.** `ARG` 는 그 아래 모든 레이어의 캐시를 무효화하므로, 위쪽(`pnpm install`)에
# 두면 커밋이 바뀔 때마다 의존을 통째로 다시 받는다 — 재배포가 1분에서 5분이 된다.
#
# `.git` 은 빌드 컨텍스트에서 빠져 있어(`.dockerignore`) 이미지가 스스로 sha 를 알 수 없다.
# 그래서 빌드하는 쪽이 심어 준다:
#   MURMUR_COMMIT=$(git rev-parse --short HEAD) docker compose build server
# 안 심으면 `null` 로 말한다 — 빌드는 그대로 된다(docs/operations.md).
ARG MURMUR_COMMIT=""
ENV MURMUR_COMMIT=$MURMUR_COMMIT

EXPOSE 3400

# compose·`docker run` 이 보는 표면이다. **k8s 는 이것을 읽지 않는다** — 거기서는 readiness
# `/readyz`, liveness `/healthz` 를 파드에 직접 적는다(docs/operations.md).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/readyz" || exit 1

# `pnpm start` 가 아니라 tsx 를 직접 부른다. 런타임에 `pnpm` 을 부르면 corepack 이 pnpm 을
# **그 자리에서 내려받으려 든다** — 그 캐시는 deps 스테이지에만 있고, 이그레스가 막힌
# 클러스터에서 그것은 기동 실패다. 부르는 것은 `package.json` 의 `start` 와 같은 명령이다.
CMD ["tsx", "src/main.ts"]
