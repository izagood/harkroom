#!/usr/bin/env bash
# 빌드한 앱 실행 파일을 **직접 띄워** 기동하자마자 죽지 않는지 본다.
#
#   launch-smoke.sh <실행 파일> [버틸 초, 기본 10]
#
# 왜 있나(2026-10-06): #1174 가 `tauri.macos.conf.json` 의 `app.windows` 를 통째로 덮으면서
# `create: false` 가 빠져, macOS 에서 main 창이 두 번 만들어지고 `setup` 이 panic → 앱이 켜자마자
# SIGABRT 로 죽었다. 0.3.191~0.3.203 열세 판이 그렇게 나갔다. `macos-build` 는 번들을 **만들고 열어
# 보기만** 했지 띄우지 않아서 아무도 못 잡았다. 설정 병합은 #1213 의 시험이 지키고, 이 스크립트는
# 그 밖의 "켜자마자 죽는" 고장 전부를 산출물에서 막는다.
#
# 실패로 치는 것 셋:
#   1. 정해진 초 안에 프로세스가 끝났다(종료 코드 무관 — 0 으로 끝나도 앱으로서는 죽은 것이다).
#   2. 출력에 Rust panic(`panicked at`)이 있다 — 다른 스레드의 panic 은 프로세스를 안 죽일 수 있다.
#   3. `setup` 끝 표지(`HARKROOM_LAUNCH_SMOKE` 를 켜면 `main.rs` 의 setup 이 찍는다)가 없다 —
#      살아 있어도 setup 에 못 닿았으면(이벤트 루프 전에 매달림) 확인한 것이 없다.
#
# `ci.yml` 의 `macos-build`(서명 전 .app)와 `release.yml`(서명한 .app, 공증·업로드 전)이 부른다.
set -uo pipefail
bin="$1"
secs="${2:-10}"
marker="harkroom-launch-smoke: setup done"
test -x "$bin" || { echo "::error::실행 파일이 없다: $bin"; exit 1; }

log="$(mktemp)"
HARKROOM_LAUNCH_SMOKE=1 RUST_BACKTRACE=1 "$bin" >"$log" 2>&1 &
pid=$!
t0=$SECONDS

alive=1
for ((i = 0; i < secs * 4; i++)); do
  sleep 0.25
  if ! kill -0 "$pid" 2>/dev/null; then alive=0; break; fi
done

if [ "$alive" -eq 1 ]; then
  # 살아 있으면 끈다. 자식(웹뷰 도우미 등)도 함께 — TERM 을 듣지 않으면 KILL.
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < 20; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
else
  wait "$pid"
  status=$?
fi

echo "--- 앱 출력 ---"
cat "$log"
echo "--- 끝 ---"

fail=0
if [ "$alive" -eq 0 ]; then
  if [ "$status" -gt 128 ]; then
    how="시그널 $((status - 128))($(kill -l $((status - 128)) 2>/dev/null || echo '?'))"
  else
    how="종료 코드 $status"
  fi
  echo "::error::앱이 $((SECONDS - t0))초 만에 끝났다 — $how (${secs}초는 버텨야 한다)"
  fail=1
fi
if grep -q "panicked at" "$log"; then
  echo "::error::앱 출력에 panic 이 있다"
  fail=1
fi
if ! grep -qF "$marker" "$log"; then
  echo "::error::setup 끝 표지가 없다 — setup 에 닿지 못했다: '$marker'"
  fail=1
fi
rm -f "$log"
[ "$fail" -eq 0 ] || exit 1
echo "ok  ${secs}초 동안 살아 있었고 setup 을 지났다"
