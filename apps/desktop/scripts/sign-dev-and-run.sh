#!/bin/sh
# cargo `runner` 훅. 서명한 **뒤** 본체를 그대로 실행한다.
#
# ## cwd 를 가정하지 않는다
#
# cargo 가 이 스크립트를 **어느 디렉터리에서 부르는지에 기대지 않는다.** 처음에
# `scripts/sign-dev-and-run.sh` 라는 상대 경로로 뒀다가 실제 실행에서 깨졌다:
#
#     sh: scripts/sign-dev-and-run.sh: No such file or directory
#
# 그래서 `$0` 에서 자기 위치를 계산해 옆의 `sign-dev.sh` 를 찾는다. 이러면 호출자가
# 어디서 부르든 같은 파일을 집는다.
#
# `exec` 로 넘기는 것이 중요하다 — 새 프로세스를 만들지 않아야 Ctrl-C 와 종료 코드가
# 그대로 전달되고, `tauri dev` 가 자식을 추적하는 방식도 깨지지 않는다.
set -eu
BIN="$1"
shift
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 서명은 **거들 뿐이다** — 실패해도 앱은 떠야 한다. 인증서가 없는 기계가 정상이다.
sh "$HERE/sign-dev.sh" "$BIN" || true
exec "$BIN" "$@"
