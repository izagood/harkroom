#!/usr/bin/env bash
# 실행 파일이 링크된 macOS SDK 가 최소 판 이상인지 본다.
#
#   check-link-sdk.sh <실행 파일> <최소 SDK 주 판>
#
# 왜 있나(2026-09-30): macOS 26 은 **SDK 26 미만으로 링크된 앱을 옛 모양으로 그린다** — 신호등이
# 지름 12pt 로 작아지고, `tauri.macos.conf.json` 의 `trafficLightPosition` 도 다른 자리에 선다
# (`src/lib/platform.ts` 의 `MAC_TRAFFIC_LIGHT_POSITION` 주석). SDK 는 러너의 Xcode 를 따라가므로
# 러너 이미지가 바뀌면 빌드는 초록인 채로 달라진다. 설치해 보기 전에는 드러나지 않아서 산출물에서
# 막는다. `release.yml`(서명 전)과 `ci.yml` 의 `macos-build`(이 스크립트 자체의 회귀선)가 부른다.
set -euo pipefail
bin="$1"
min="$2"
test -f "$bin" || { echo "::error::실행 파일이 없다: $bin"; exit 1; }
xcodebuild -version || true
info="$(otool -l "$bin" | grep -A4 LC_BUILD_VERSION)"
echo "$info"
sdk="$(echo "$info" | awk '$1 == "sdk" { print $2; exit }')"
if [ -z "$sdk" ]; then
  echo "::error::LC_BUILD_VERSION 에서 sdk 를 읽지 못했다: $bin"
  exit 1
fi
if [ "${sdk%%.*}" -lt "$min" ]; then
  echo "::error::앱이 SDK $sdk 로 링크됐다 — $min 이상이어야 한다(macOS 26 이 옛 모양으로 그린다)"
  exit 1
fi
echo "ok  SDK $sdk (>= $min)"
