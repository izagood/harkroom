# Rust 앞단(`harkroom-server-rs`, S5.1) 이미지. 빌드 컨텍스트는 저장소 루트다 — `build.rs` 가 TS 서버의
# 마이그레이션 파일 이름(`crates/harkroom-server/migrations/*.sql`)을 바이너리에 굽기 때문이다.
#
# 두 스테이지: `build` 에서 `cargo build --locked --release` 하고, 배포 이미지에는 바이너리 하나만 넘긴다.
# 런타임은 distroless `cc`(glibc·libgcc 만, 셸 없음)에 nonroot(uid 65532)다 — 앞단은 파일을 쓰지 않는다.
# TLS 를 쓰지 않는다(sqlx `postgres` 만, 클러스터 안 평문 PG·TS 서버) — 그래서 openssl·인증서가 필요 없다.

# ─────────────────────────────────────────────────────────────────────────────
# 1) build — 배포되지 않는다
# ─────────────────────────────────────────────────────────────────────────────
FROM rust:1.96-slim-trixie AS build
WORKDIR /src

# 의존만 먼저 받는다(소스가 바뀌어도 이 층은 캐시에 남는다).
# 경로 의존(`harkroom-bus` 이벤트 outbox 쓰는 쪽, `harkroom-proto` 경계 모양·승인 규칙 판정)도 같이 넘긴다 —
# 없으면 fetch 가 그 매니페스트를 못 찾는다. `Cargo.toml` 의 `path = "../…"` 를 늘리면 여기도 늘린다.
COPY crates/harkroom-bus crates/harkroom-bus
COPY crates/harkroom-proto crates/harkroom-proto
COPY crates/harkroom-server/Cargo.toml crates/harkroom-server/Cargo.lock crates/harkroom-server/
RUN cd crates/harkroom-server && cargo fetch --locked

COPY crates/harkroom-server/migrations crates/harkroom-server/migrations
# 릴리스 판의 정본(TS 이미지와 같은 파일). `build.rs` 가 그 `version` 을 바이너리에 굽는다 — `/healthz` 의 `version`.
COPY packages/desktop/src-tauri/tauri.conf.json packages/desktop/src-tauri/tauri.conf.json
COPY crates/harkroom-server crates/harkroom-server
RUN cd crates/harkroom-server \
 && cargo build --locked --release --bin harkroom-server-rs \
 && cp target/release/harkroom-server-rs /harkroom-server-rs

# ─────────────────────────────────────────────────────────────────────────────
# 2) runtime — 실제로 배포되는 이미지
# ─────────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/cc-debian13:nonroot AS runtime
COPY --from=build /harkroom-server-rs /usr/local/bin/harkroom-server-rs

# env: `UPSTREAM_URL`(TS 서버) · `DATABASE_URL` · `PORT`(기본 3500). 셋 중 앞의 둘이 없으면 기동하지 않는다.
ENV PORT=3500
EXPOSE 3500
USER 65532:65532

# **맨 끝에 둔다**(TS 이미지와 같은 방식·같은 이름). `.git` 은 빌드 컨텍스트에 없어 이미지가 스스로 sha 를 모른다 —
# 빌드하는 쪽(`image.yml` 의 `build-args`)이 심는다. 안 심으면 `/healthz` 의 `commit` 은 `null` 이다.
ARG HARKROOM_COMMIT=""
ENV HARKROOM_COMMIT=$HARKROOM_COMMIT

ENTRYPOINT ["/usr/local/bin/harkroom-server-rs"]
