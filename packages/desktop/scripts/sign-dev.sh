#!/bin/sh
# 개발 빌드에 **고정 신원**을 붙인다 — 키체인 승인이 재빌드마다 다시 뜨는 것을 막는다.
#
# ## 왜 필요한가 (실측 2026-09-06)
#
# 러너 기동은 에이전트마다 PAT 를 따로 읽는다(`murmur.runner.pat.<agentId>`). 그래서
# 승인이 다시 걸리면 **러너 수만큼** 대화상자가 뜬다 — 에이전트 6개면 6번이다.
#
# 승인이 다시 걸리는 이유는 서명이 없어서가 아니다. Apple silicon 에서는 링커가 ad-hoc
# 서명을 자동으로 붙인다(`flags=0x20002(adhoc,linker-signed)`). 문제는 **ad-hoc 서명의
# designated requirement 가 내용 해시 그 자체**라는 것이다:
#
#     bin_a -> cdhash H"8086fea0..."
#     bin_b -> cdhash H"28d4589b..."     # 별개로 빌드한 같은 프로그램
#
# 키체인 ACL 은 이 requirement 로 대조되므로, 재빌드로 해시가 바뀌면 macOS 에게는
# **다른 앱**이고 승인을 처음부터 다시 받는다. ad-hoc 을 "고정"하는 것은 불가능하다 —
# 해시가 곧 신원이라 내용이 바뀌면 반드시 바뀐다.
#
# 이름 있는 인증서로 서명하면 requirement 에서 해시가 사라진다:
#
#     designated => identifier "app.harkroom.desktop.dev" and anchor ...
#
# 두 빌드가 글자 그대로 같아진다 — 그래서 승인이 한 번으로 끝난다.
#
# ## 인증서가 없으면 아무것도 하지 않는다
#
# 이 인증서는 **각자 자기 기계에서 만드는 것**이고 저장소에 담기지 않는다(담을 수도 없다 —
# 개인 키다). 없는 기계에서 실패로 처리하면 남의 빌드가 깨지므로, 조용히 넘어가고
# 링커의 ad-hoc 서명을 그대로 둔다. 그 기계는 지금까지와 똑같이 동작한다.
set -eu

# 이름은 `sign-app.mjs` 와 **같은 환경변수**로 덮을 수 있다 — 서명 신원을 고르는 자리가
# 개발과 릴리즈에서 갈라지면, 한쪽만 고쳐 놓고 다른 쪽이 왜 안 되는지 찾게 된다.
IDENTITY="${MURMUR_SIGN_IDENTITY:-murmur-dev}"
BIN="${1:-src-tauri/target/debug/harkroom-desktop}"

[ -f "$BIN" ] || exit 0

# `-p codesigning` 으로 **코드 서명에 쓸 수 있는 것만** 본다. Certificate Type 을
# 잘못 골라 만든 인증서(예: SSL Server)는 여기 안 잡히고, 그때 서명을 시도하면
# 실패해 빌드가 죽는다 — 조용히 넘어가는 편이 낫다.
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  exit 0
fi

# `--identifier` 를 **고정**한다. 이것이 requirement 에 들어가는 이름이고, 비워 두면
# cargo 가 만든 해시 섞인 기본 식별자(`harkroom_desktop-2cf138358ac0eb80`)가 쓰여
# 다시 불안정해진다.
codesign -f -s "$IDENTITY" --identifier app.harkroom.desktop.dev "$BIN" 2>/dev/null || exit 0
echo "[sign-dev] $IDENTITY 로 서명했다: $BIN"
