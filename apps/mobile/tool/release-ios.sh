#!/bin/sh
# iOS 릴리스: 시뮬레이터 E2E → 서명된 IPA → 서명 검증 → TestFlight 업로드.
#
# 로컬에서 그대로 돌리고, CI(`.github/workflows/testflight.yml`)도 서명 자료를 깔아 둔 뒤
# 이 파일을 부른다 — 두 길이 다른 단계를 밟으면 한쪽에서만 나는 실패가 생긴다.
#
# 사용법:
#   apps/mobile/tool/release-ios.sh              # 전체 (E2E → 빌드 → 업로드)
#   apps/mobile/tool/release-ios.sh --skip-e2e   # 빌드부터
#   apps/mobile/tool/release-ios.sh --no-upload  # 업로드 직전까지
#
# 서명 자료는 **저장소 밖**에 둔다. 기본 자리는 ~/.harkroom-signing 이고
# HARKROOM_SIGNING_DIR 로 바꾼다. 그 안에:
#   AuthKey_<KEY_ID>.p8   App Store Connect API 키
#   values.txt            ASC_KEY_ID= / ASC_ISSUER_ID= / ASC_APP_ID= 세 줄
# 같은 이름의 환경 변수가 있으면 values.txt 보다 먼저 쓴다(CI 는 secret 에서 넣는다).
#
# **비밀값을 출력하지 않는다.** `set -x` 를 켜지 마라 — 키 id·issuer·앱 id 가 로그에 찍힌다.
set -eu

FLUTTER="${FLUTTER:-flutter}"
SIGNING_DIR="${HARKROOM_SIGNING_DIR:-$HOME/.harkroom-signing}"
SIMULATOR_NAME="${HARKROOM_SIMULATOR:-}"

skip_e2e=0
no_upload=0
for arg in "$@"; do
  case "$arg" in
    --skip-e2e) skip_e2e=1 ;;
    --no-upload) no_upload=1 ;;
    *) echo "알 수 없는 인자: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$1"; }

# values.txt 에서 한 줄을 읽는다. 환경 변수가 있으면 그것이 먼저다.
value() {
  eval "current=\${$1:-}"
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  test -f "$SIGNING_DIR/values.txt" || { echo "$1 이 없다(환경 변수도 $SIGNING_DIR/values.txt 도)." >&2; exit 1; }
  grep "^$1=" "$SIGNING_DIR/values.txt" | cut -d= -f2-
}

# --- 선행 조건 -------------------------------------------------------------
# 빌드 도중이 아니라 여기서 죽어야 원인이 분명하다.
say "선행 조건 확인"

# 서명 ID 가 유효한지 본다. WWDR 중간 인증서가 없으면 인증서를 키체인에 넣고도
# "0 valid identities" 가 나오며, 그 상태로 빌드하면 한참 뒤에야 실패한다.
if ! security find-identity -v -p codesigning | grep -q "Apple Distribution"; then
  echo "유효한 Apple Distribution 서명 ID 가 없다." >&2
  echo "인증서를 키체인에 넣고, WWDR 중간 인증서가 빠졌으면 함께 넣는다:" >&2
  echo "  curl -fsSL -o /tmp/wwdr.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer" >&2
  echo "  security import /tmp/wwdr.cer -k ~/Library/Keychains/login.keychain-db" >&2
  exit 1
fi
test -f ios/ExportOptions.plist || { echo "ios/ExportOptions.plist 가 없다." >&2; exit 1; }

key_id=$(value ASC_KEY_ID)
issuer_id=$(value ASC_ISSUER_ID)
app_id=$(value ASC_APP_ID)
key_path="$SIGNING_DIR/AuthKey_$key_id.p8"
test -f "$key_path" || { echo "API 키 파일이 없다: $SIGNING_DIR/AuthKey_<KEY_ID>.p8" >&2; exit 1; }

$FLUTTER pub get --enforce-lockfile

# --- 빌드 번호 -------------------------------------------------------------
# App Store Connect 를 유일한 진실로 삼는다. 로컬 카운터를 쓰면 --no-upload 로 만든 빌드까지
# 번호를 소비해 실제 업로드분과 어긋나고, CI 가 붙으면 서로 다른 카운터끼리 충돌한다.
say "빌드 번호 조회"
build_number=$(
  ASC_KEY_ID="$key_id" ASC_ISSUER_ID="$issuer_id" ASC_APP_ID="$app_id" \
  ASC_PRIVATE_KEY_PATH="$key_path" node tool/next-build-number.mjs
)
echo "빌드 번호: $build_number"

# --- E2E -------------------------------------------------------------------
if [ "$skip_e2e" -eq 0 ]; then
  # 지난 실행이 남긴 Runner 를 먼저 치운다 — 오래 산 Runner 가 E2E 를 멈춰 세운 일이 있다.
  stale=$(pgrep -f 'CoreSimulator/Devices/.*/Runner\.app/Runner' || true)
  if [ -n "$stale" ]; then
    say "지난 실행이 남긴 시뮬레이터 프로세스 정리"
    echo "$stale" | xargs kill -9 2>/dev/null || true
    xcrun simctl shutdown all 2>/dev/null || true
    sleep 2
  fi

  say "시뮬레이터 E2E"
  # 이름을 안 주면 쓸 수 있는 첫 iPhone 을 고른다.
  udid=$(xcrun simctl list devices available --json | python3 -c "
import sys, json
want = '$SIMULATOR_NAME'
for runtime, devices in json.load(sys.stdin)['devices'].items():
    for d in devices:
        if (want and d['name'] == want) or (not want and d['name'].startswith('iPhone')):
            print(d['udid']); sys.exit(0)
sys.exit(1)")
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b
  trap 'xcrun simctl shutdown "$udid" 2>/dev/null || true' EXIT

  # 상한을 둔다. 멈춘 E2E 는 느린 E2E 와 화면상 구별되지 않는다. macOS 에는 `timeout` 이
  # 기본으로 없어서, 있으면 쓰고 없으면 그냥 돌린다.
  e2e_timeout=""
  if command -v timeout >/dev/null; then e2e_timeout="timeout 900"
  elif command -v gtimeout >/dev/null; then e2e_timeout="gtimeout 900"
  fi
  # 실서버 시험(live_tour)은 자격증명이 없으면 스스로 건너뛴다.
  status=0
  $e2e_timeout $FLUTTER test integration_test -d "$udid" || status=$?
  if [ "$status" -ne 0 ]; then
    [ "$status" -eq 124 ] && echo "E2E 가 15분 안에 끝나지 않았다. 시뮬레이터가 멈춘 것으로 본다." >&2
    exit "$status"
  fi
fi

# --- 빌드 ------------------------------------------------------------------
say "서명된 IPA 빌드"
$FLUTTER build ipa \
  --release \
  --build-number="$build_number" \
  --export-options-plist=ios/ExportOptions.plist

ipa=$(ls build/ios/ipa/*.ipa | head -1)

# 서명 체인을 여기서 확인한다. 업로드는 느리고, 서명이 깨졌다면 그 전에 알아야 한다.
# .ipa 는 zip 이라 codesign 이 직접 읽지 못한다 — 풀어서 .app 에 건다.
say "서명 검증"
verify_dir=$(mktemp -d)
unzip -q "$ipa" -d "$verify_dir"
codesign -dv --verbose=2 "$verify_dir/Payload/Runner.app" 2>&1 \
  | grep -E "^Authority|^TeamIdentifier|^Identifier"
codesign -dv --verbose=2 "$verify_dir/Payload/Runner.app" 2>&1 \
  | grep -q "Authority=Apple Root CA" \
  || { echo "서명 체인이 Apple Root CA 까지 닿지 않는다." >&2; rm -rf "$verify_dir"; exit 1; }
rm -rf "$verify_dir"

if [ "$no_upload" -eq 1 ]; then
  say "업로드 생략 — $ipa"
  exit 0
fi

# --- 업로드 ----------------------------------------------------------------
# altool 은 이 고정 경로에서만 키를 찾는다. 경로와 파일명 모두 규칙이다.
mkdir -p ~/.appstoreconnect/private_keys
cp "$key_path" ~/.appstoreconnect/private_keys/
chmod 600 ~/.appstoreconnect/private_keys/"AuthKey_$key_id.p8"

# 업로드는 되돌릴 수 없다(빌드 삭제 불가, 만료 처리만 가능). 검증을 먼저 통과시킨다.
say "업로드 전 검증"
xcrun altool --validate-app --type ios --file "$ipa" --apiKey "$key_id" --apiIssuer "$issuer_id"

say "TestFlight 업로드"
xcrun altool --upload-app --type ios --file "$ipa" --apiKey "$key_id" --apiIssuer "$issuer_id"

say "완료 — 빌드 $build_number 가 TestFlight 처리 중이다 (5~15분)"
