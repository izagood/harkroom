#!/bin/sh
# Tests for ops/install.sh that need no network and no Linux: platform refusal branches (stubbed uname /
# libc), checksum verification against a local fake tarball, install / re-install / uninstall into a temp HOME.
#   sh ops/install.test.sh
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/install.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fails=0

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# run <expected exit: 0|fail> <text expected in output> <name> -- env assignments and args for install.sh
run() {
  want="$1"; text="$2"; name="$3"; shift 4
  set +e
  out="$(env HOME="$work/home" XDG_DATA_HOME= XDG_CONFIG_HOME= PATH="$work/stub:$PATH" \
    HARKROOM_INSTALL_TEST_UNAME_S=Linux HARKROOM_INSTALL_TEST_UNAME_M=x86_64 HARKROOM_INSTALL_TEST_LIBC="glibc 2.39" \
    "$@" 2>&1)"
  code=$?
  set -e
  ok=1
  if [ "$want" = 0 ] && [ "$code" -ne 0 ]; then ok=0; fi
  if [ "$want" = fail ] && [ "$code" -eq 0 ]; then ok=0; fi
  case "$out" in *"$text"*) ;; *) ok=0 ;; esac
  if [ "$ok" -eq 1 ]; then printf 'ok   %s\n' "$name"; else
    printf 'FAIL %s (exit %s)\n%s\n' "$name" "$code" "$out"; fails=$((fails + 1)); fi
}

# A systemctl stub so the tests never touch a real user session.
mkdir -p "$work/stub" "$work/home" "$work/rel"
printf '#!/bin/sh\nexit 0\n' > "$work/stub/systemctl"; chmod +x "$work/stub/systemctl"

# Fake release: same layout as the real tarball.
ver=9.9.9
top="harkroom-operator-$ver-linux-x86_64"
mkdir -p "$work/build/$top/bin" "$work/build/$top/share"
printf '#!/bin/sh\necho fake-operator\n' > "$work/build/$top/bin/harkroom-operator-rs"
printf '#!/bin/sh\necho fake-runner\n' > "$work/build/$top/bin/harkroom-runner-rs"
cp "$here/operator@.service.template" "$work/build/$top/share/"
tar -czf "$work/rel/$top.tar.gz" -C "$work/build" "$top"
printf '%s  %s\n' "$(sha "$work/rel/$top.tar.gz")" "$top.tar.gz" > "$work/rel/SHA256SUMS"

run fail "for Linux" "refuses macOS" -- HARKROOM_INSTALL_TEST_UNAME_S=Darwin sh "$script" --version $ver --from-dir "$work/rel"
run fail "unsupported operating system" "refuses other OS" -- HARKROOM_INSTALL_TEST_UNAME_S=FreeBSD sh "$script" --version $ver --from-dir "$work/rel"
run fail "unsupported CPU" "refuses riscv64" -- HARKROOM_INSTALL_TEST_UNAME_M=riscv64 sh "$script" --version $ver --from-dir "$work/rel"
run fail "musl" "refuses musl" -- HARKROOM_INSTALL_TEST_LIBC=musl sh "$script" --version $ver --from-dir "$work/rel"
run fail "too old" "refuses old glibc" -- HARKROOM_INSTALL_TEST_LIBC="glibc 2.31" sh "$script" --version $ver --from-dir "$work/rel"
run fail "does not look like a version" "refuses odd version" -- sh "$script" --version '../x' --from-dir "$work/rel"
run fail "unknown option" "refuses unknown flag" -- sh "$script" --frobnicate

# checksum mismatch: nothing may be installed
mkdir -p "$work/bad"; cp "$work/rel/$top.tar.gz" "$work/bad/"
printf '%064d  %s\n' 0 "$top.tar.gz" > "$work/bad/SHA256SUMS"
run fail "checksum mismatch" "checksum mismatch fails closed" -- sh "$script" --version $ver --from-dir "$work/bad"
: > "$work/bad/SHA256SUMS"
run fail "no entry" "missing checksum entry fails closed" -- sh "$script" --version $ver --from-dir "$work/bad"
if [ -e "$work/home/.local/share/harkroom" ]; then echo "FAIL something was installed after a failed verification"; fails=$((fails + 1)); fi

# archive with a path outside its top directory
mkdir -p "$work/evil/build/other"; : > "$work/evil/build/other/x"
tar -czf "$work/evil/$top.tar.gz" -C "$work/evil/build" other
printf '%s  %s\n' "$(sha "$work/evil/$top.tar.gz")" "$top.tar.gz" > "$work/evil/SHA256SUMS"
run fail "unexpected paths" "refuses archive outside its top dir" -- sh "$script" --version $ver --from-dir "$work/evil"

# install, state survives a re-install, uninstall keeps state
run 0 "installed harkroom-operator v$ver" "installs (aarch64 name mapping: amd64 -> x86_64)" -- HARKROOM_INSTALL_TEST_UNAME_M=amd64 sh "$script" --version v$ver --from-dir "$work/rel"
p="$work/home/.local/share/harkroom"
unit="$work/home/.config/systemd/user/harkroom-operator@.service"
check() { if "$@"; then printf 'ok   %s\n' "$*"; else printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); fi; }
check test -x "$p/bin/harkroom-operator-rs"
check test -x "$p/bin/harkroom-runner-rs"
check test -L "$work/home/.local/bin/harkroom-operator"
check test "$("$work/home/.local/bin/harkroom-operator")" = fake-operator
check grep -q "^ExecStart=$p/bin/harkroom-operator-rs serve --base-url .* --runner-command $p/bin/harkroom-runner-rs " "$unit"
if grep -q '@BIN@\|@RUNNER@' "$unit"; then echo "FAIL placeholders left in the unit"; fails=$((fails + 1)); fi
printf 'BASE_URL=https://chat.example.com\n' > "$work/home/.config/harkroom/operator-abcd1234.env"
run 0 "installed harkroom-operator v$ver" "re-install is idempotent" -- sh "$script" --version $ver --from-dir "$work/rel"
check test -f "$work/home/.config/harkroom/operator-abcd1234.env"
run 0 "removed the harkroom operator" "uninstalls" -- sh "$script" --uninstall
check test ! -e "$p"
check test ! -e "$unit"
check test ! -e "$work/home/.local/bin/harkroom-operator"
check test -f "$work/home/.config/harkroom/operator-abcd1234.env"

if [ "$fails" -ne 0 ]; then printf '%s test(s) failed\n' "$fails"; exit 1; fi
echo "all install.sh tests passed"
