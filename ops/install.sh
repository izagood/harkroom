#!/bin/sh
# Harkroom operator installer for Linux (glibc, x86_64 / aarch64).
#
# Recommended use — download, read, then run:
#   curl --proto '=https' --tlsv1.2 -fsSLO https://github.com/izagood/harkroom/releases/latest/download/install.sh
#   sh install.sh
#
# What it does:
#   1. checks that this is Linux + glibc on a supported CPU
#   2. downloads harkroom-operator-<version>-linux-<arch>.tar.gz and SHA256SUMS from the GitHub release
#   3. verifies the tarball's SHA-256 against SHA256SUMS (fails closed)
#   4. installs under a user-owned prefix (no sudo), links the binaries into a bin dir
#   5. writes the systemd *user* unit template (never enables or starts anything unless --enable is given)
#
# It never touches operator state (~/.harkroom-agent, ~/.config/harkroom/*.env) — re-running upgrades in place.
#
# Trust model in this version: the checksum file comes from the same release as the tarball, over TLS. That
# catches corruption and truncated downloads, not a compromised release. Signature verification hooks in at
# `verify_signature` below.
set -eu

REPO="izagood/harkroom"
RELEASES="https://github.com/${REPO}/releases"
MIN_GLIBC_MAJOR=2
MIN_GLIBC_MINOR=35
UNIT_NAME="harkroom-operator@.service"

VERSION="${HARKROOM_VERSION:-}"
PREFIX="${HARKROOM_PREFIX:-}"
BIN_DIR="${HARKROOM_BIN_DIR:-}"
FROM_DIR="${HARKROOM_INSTALL_FROM_DIR:-}"
ENABLE_KEY=""
UNINSTALL=0
NO_UNIT=0
TMP=""

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Usage: sh install.sh [options]

  --version <x.y.z>   install this release (default: latest; env HARKROOM_VERSION)
  --prefix <dir>      install root (default: ~/.local/share/harkroom; env HARKROOM_PREFIX)
  --bin-dir <dir>     where to link the commands (default: ~/.local/bin; env HARKROOM_BIN_DIR)
  --from-dir <dir>    use a tarball + SHA256SUMS already in <dir> instead of downloading (offline install)
  --no-unit           do not write the systemd user unit
  --enable <key>      also `systemctl --user enable --now harkroom-operator@<key>` (needs its env file first)
  --uninstall         remove the binaries, links and unit (keeps operator state and env files)
  -h, --help          this text
EOF
}

need_arg() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) need_arg "$@"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --prefix) need_arg "$@"; PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --bin-dir) need_arg "$@"; BIN_DIR="$2"; shift 2 ;;
    --bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
    --from-dir) need_arg "$@"; FROM_DIR="$2"; shift 2 ;;
    --from-dir=*) FROM_DIR="${1#*=}"; shift ;;
    --enable) need_arg "$@"; ENABLE_KEY="$2"; shift 2 ;;
    --enable=*) ENABLE_KEY="${1#*=}"; shift ;;
    --no-unit) NO_UNIT=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "${HOME:-}" ] || die "HOME is not set"
[ -n "$PREFIX" ] || PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/harkroom"
[ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/harkroom"
case "$PREFIX" in /*) ;; *) die "--prefix must be an absolute path: $PREFIX" ;; esac
case "$BIN_DIR" in /*) ;; *) die "--bin-dir must be an absolute path: $BIN_DIR" ;; esac
# The values below end up in a sed replacement and a unit file — keep them boring.
case "$PREFIX$BIN_DIR" in *[!A-Za-z0-9/._+-]*) die "--prefix / --bin-dir may only contain letters, digits and / . _ + -" ;; esac
case "$ENABLE_KEY" in *[!A-Za-z0-9._-]*) die "--enable takes a community key (letters and digits)" ;; esac

cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- platform ---------------------------------------------------------------------------------------------
# The HARKROOM_INSTALL_TEST_* variables exist for the script's own tests (ops/install.test.sh).

detect_os() {
  os="${HARKROOM_INSTALL_TEST_UNAME_S:-$(uname -s)}"
  case "$os" in
    Linux) ;;
    Darwin) die "this installer is for Linux. On macOS the operator ships inside the Harkroom desktop app." ;;
    *) die "unsupported operating system: $os (Linux only)" ;;
  esac
}

detect_arch() {
  machine="${HARKROOM_INSTALL_TEST_UNAME_M:-$(uname -m)}"
  case "$machine" in
    x86_64|amd64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *) die "unsupported CPU architecture: $machine (supported: x86_64, aarch64)" ;;
  esac
}

# Prints "glibc <version>", "musl" or "unknown".
libc_probe() {
  if [ -n "${HARKROOM_INSTALL_TEST_LIBC:-}" ]; then say "$HARKROOM_INSTALL_TEST_LIBC"; return; fi
  if have getconf && v="$(getconf GNU_LIBC_VERSION 2>/dev/null)"; then
    say "glibc ${v#glibc }"; return
  fi
  if have ldd; then
    out="$(ldd --version 2>&1 || true)"
    case "$out" in
      *musl*) say "musl"; return ;;
      *GLIBC*|*"GNU libc"*)
        say "glibc $(printf '%s\n' "$out" | sed -n '1s/.* \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"; return ;;
    esac
  fi
  for f in /lib/ld-musl-*.so.1; do [ -e "$f" ] && { say "musl"; return; }; done
  say "unknown"
}

detect_libc() {
  libc="$(libc_probe)"
  case "$libc" in
    musl) die "musl libc (e.g. Alpine) is not supported — the release binaries are built for glibc ${MIN_GLIBC_MAJOR}.${MIN_GLIBC_MINOR}+. Build from source instead (see README)." ;;
    "glibc "*)
      gv="${libc#glibc }"
      major="${gv%%.*}"; rest="${gv#*.}"; minor="${rest%%.*}"
      case "$major$minor" in ''|*[!0-9]*) warn "could not read the glibc version ($gv); continuing"; return ;; esac
      if [ "$major" -lt "$MIN_GLIBC_MAJOR" ] || { [ "$major" -eq "$MIN_GLIBC_MAJOR" ] && [ "$minor" -lt "$MIN_GLIBC_MINOR" ]; }; then
        die "glibc $gv is too old — the release binaries need glibc ${MIN_GLIBC_MAJOR}.${MIN_GLIBC_MINOR}+ (Ubuntu 22.04, Debian 12, RHEL 10 or newer). Build from source instead (see README)."
      fi ;;
    *) warn "could not tell which libc this system uses; the binaries need glibc ${MIN_GLIBC_MAJOR}.${MIN_GLIBC_MINOR}+" ;;
  esac
}

# --- download + verify ------------------------------------------------------------------------------------

fetch() { # fetch <url> <output file>
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
}

resolve_version() {
  if [ -z "$VERSION" ]; then
    [ -z "$FROM_DIR" ] || die "--from-dir needs --version"
    # /releases/latest redirects to /releases/tag/v<version> — read the tag off the final URL.
    final="$(curl --proto '=https' --tlsv1.2 -fsSL -o /dev/null -w '%{url_effective}' "$RELEASES/latest")" \
      || die "could not find the latest release ($RELEASES/latest)"
    VERSION="${final##*/}"
  fi
  VERSION="${VERSION#v}"
  case "$VERSION" in
    ''|*[!0-9A-Za-z.+-]*|.*|-*) die "this does not look like a version: $VERSION" ;;
    [0-9]*.[0-9]*) ;;
    *) die "this does not look like a version: $VERSION" ;;
  esac
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif have openssl; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else die "need sha256sum, shasum or openssl to verify the download"
  fi
}

verify_checksum() { # verify_checksum <tarball> <SHA256SUMS> <asset name>
  want="$(awk -v n="$3" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print $1; exit } }' "$2")"
  [ -n "$want" ] || die "SHA256SUMS has no entry for $3 — refusing to install"
  case "$want" in *[!0-9a-fA-F]*) die "SHA256SUMS entry for $3 is malformed — refusing to install" ;; esac
  [ "${#want}" -eq 64 ] || die "SHA256SUMS entry for $3 is malformed — refusing to install"
  got="$(sha256_of "$1")"
  want="$(printf '%s' "$want" | tr 'A-F' 'a-f')"
  [ "$got" = "$want" ] || die "checksum mismatch for $3
  expected $want
  got      $got
Nothing was installed."
  say "checksum ok: $3"
}

# Placeholder for the signed-release step: verify a detached signature of SHA256SUMS against a public key
# pinned in this script, before verify_checksum trusts the file. Not implemented in this version.
verify_signature() { # verify_signature <SHA256SUMS>
  :
}

# Refuse archives that could write outside their own top-level directory.
check_archive() { # check_archive <tarball> <top dir>
  tar -tzf "$1" > "$TMP/listing" || die "the archive is not readable"
  bad="$(awk -v top="$2" '
    /^\// || /(^|\/)\.\.(\/|$)/ { print; next }
    $0 != top && $0 != top "/" && index($0, top "/") != 1 { print }
  ' "$TMP/listing")"
  [ -z "$bad" ] || die "the archive has unexpected paths — refusing to unpack"
  if tar -tvzf "$1" | grep -q '^[lh]'; then die "the archive contains links — refusing to unpack"; fi
}

# --- install ----------------------------------------------------------------------------------------------

install_unit() { # install_unit <template>
  [ "$NO_UNIT" -eq 0 ] || return 0
  mkdir -p "$UNIT_DIR" "$ENV_DIR"
  sed -e "s|@BIN@|$PREFIX/bin/harkroom-operator-rs|g" -e "s|@RUNNER@|$PREFIX/bin/harkroom-runner-rs|g" \
    "$1" > "$UNIT_DIR/$UNIT_NAME.tmp.$$"
  mv -f "$UNIT_DIR/$UNIT_NAME.tmp.$$" "$UNIT_DIR/$UNIT_NAME"
  say "systemd user unit: $UNIT_DIR/$UNIT_NAME"
  if have systemctl; then
    systemctl --user daemon-reload >/dev/null 2>&1 \
      || warn "could not reach the systemd user session — run: systemctl --user daemon-reload"
  else
    warn "systemctl not found — the unit was written but this system does not seem to use systemd"
  fi
}

do_install() {
  detect_os; detect_arch; detect_libc
  have tar || die "tar is required"
  [ -n "$FROM_DIR" ] || have curl || die "curl is required"
  resolve_version

  asset="harkroom-operator-${VERSION}-linux-${ARCH}.tar.gz"
  top="harkroom-operator-${VERSION}-linux-${ARCH}"
  TMP="$(mktemp -d)"

  if [ -n "$FROM_DIR" ]; then
    [ -f "$FROM_DIR/$asset" ] || die "not found: $FROM_DIR/$asset"
    [ -f "$FROM_DIR/SHA256SUMS" ] || die "not found: $FROM_DIR/SHA256SUMS"
    cp "$FROM_DIR/$asset" "$TMP/$asset"
    cp "$FROM_DIR/SHA256SUMS" "$TMP/SHA256SUMS"
  else
    say "downloading $asset (v$VERSION)"
    fetch "$RELEASES/download/v$VERSION/$asset" "$TMP/$asset" \
      || die "download failed: $RELEASES/download/v$VERSION/$asset (is v$VERSION a release with Linux builds?)"
    fetch "$RELEASES/download/v$VERSION/SHA256SUMS" "$TMP/SHA256SUMS" \
      || die "download failed: SHA256SUMS for v$VERSION — refusing to install without a checksum"
  fi

  verify_signature "$TMP/SHA256SUMS"
  verify_checksum "$TMP/$asset" "$TMP/SHA256SUMS" "$asset"
  check_archive "$TMP/$asset" "$top"

  mkdir "$TMP/x"
  tar -xzf "$TMP/$asset" -C "$TMP/x" --no-same-owner
  src="$TMP/x/$top"
  for b in harkroom-operator-rs harkroom-runner-rs; do
    [ -f "$src/bin/$b" ] || die "the archive is missing bin/$b"
  done

  mkdir -p "$PREFIX/bin" "$PREFIX/share" "$BIN_DIR"
  for b in harkroom-operator-rs harkroom-runner-rs; do
    # Copy next to the target and rename over it: a running operator keeps its old file, the next start
    # gets the new one.
    cp "$src/bin/$b" "$PREFIX/bin/.$b.new.$$"
    chmod 755 "$PREFIX/bin/.$b.new.$$"
    mv -f "$PREFIX/bin/.$b.new.$$" "$PREFIX/bin/$b"
  done
  # The runner stays next to the operator (the operator looks for it there); only the operator is linked.
  ln -sfn "$PREFIX/bin/harkroom-operator-rs" "$BIN_DIR/harkroom-operator"
  for f in "operator@.service.template" LICENSE README.md; do
    [ ! -f "$src/share/$f" ] || cp "$src/share/$f" "$PREFIX/share/$f"
  done
  printf '%s\n' "$VERSION" > "$PREFIX/VERSION"
  say "installed harkroom-operator v$VERSION to $PREFIX (linked in $BIN_DIR)"

  if [ -f "$src/share/operator@.service.template" ]; then
    install_unit "$src/share/operator@.service.template"
  elif [ "$NO_UNIT" -eq 0 ]; then
    warn "the archive has no systemd unit template — no unit was written"
  fi

  if [ -n "$ENABLE_KEY" ]; then
    [ -f "$ENV_DIR/operator-$ENABLE_KEY.env" ] \
      || die "--enable $ENABLE_KEY: $ENV_DIR/operator-$ENABLE_KEY.env does not exist yet — register first (steps below)"
    systemctl --user enable --now "harkroom-operator@$ENABLE_KEY"
    say "enabled and started harkroom-operator@$ENABLE_KEY"
  fi

  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH — add it, or call $BIN_DIR/harkroom-operator directly" ;;
  esac
  next_steps
}

next_steps() {
  cat <<EOF

Next steps
  1. Check this machine:
       harkroom-operator doctor
  2. Register this machine with your community — mint a one-time code in the desktop app
     (Settings > Agents > Operators; valid for five minutes):
       harkroom-operator register https://chat.example.com <code>
     It prints the community key (the 8 characters after c/) and the matching serve command.
  3. Account pools (optional — without one, agents run on the harness's own login on this machine;
     add a pool only to rotate between several accounts):
       harkroom-operator account list --base-url https://chat.example.com
       harkroom-operator account login <pool> <account> --base-url https://chat.example.com
  4. Keep the operator running with systemd (one instance per community):
       printf 'BASE_URL=https://chat.example.com\nEXTRA_ARGS=\n' > $ENV_DIR/operator-<key>.env
       systemctl --user enable --now harkroom-operator@<key>
       loginctl enable-linger "\$USER"      # keep it running after you log out
  5. Logs:
       journalctl --user -u harkroom-operator@<key> -f
     If that reports insufficient permissions (machines without per-user journals), read the system journal:
       sudo journalctl _SYSTEMD_USER_UNIT=harkroom-operator@<key>.service -f
     To drop the sudo, join the journal group and log in again:
       sudo usermod -aG systemd-journal "\$USER"

After an upgrade, restart running instances:  systemctl --user restart 'harkroom-operator@*'
Uninstall:  sh install.sh --uninstall
EOF
}

do_uninstall() {
  if have systemctl; then
    units="$(systemctl --user list-units --plain --no-legend --all 'harkroom-operator@*' 2>/dev/null | awk '{print $1}' || true)"
    for u in $units; do
      case "$u" in harkroom-operator@*.service) systemctl --user disable --now "$u" >/dev/null 2>&1 || true ;; esac
    done
  fi
  rm -f "$UNIT_DIR/$UNIT_NAME"
  if have systemctl; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
  # Only remove the link if it points at this prefix.
  if [ -L "$BIN_DIR/harkroom-operator" ] \
    && [ "$(readlink "$BIN_DIR/harkroom-operator")" = "$PREFIX/bin/harkroom-operator-rs" ]; then
    rm -f "$BIN_DIR/harkroom-operator"
  fi
  rm -f "$PREFIX/bin/harkroom-operator-rs" "$PREFIX/bin/harkroom-runner-rs"
  for f in "share/operator@.service.template" share/LICENSE share/README.md VERSION; do rm -f "$PREFIX/$f"; done
  for d in "$PREFIX/bin" "$PREFIX/share" "$PREFIX"; do rmdir "$d" 2>/dev/null || true; done
  say "removed the harkroom operator from $PREFIX"
  say "kept: operator state (~/.harkroom-agent) and env files ($ENV_DIR) — delete them yourself if you no longer need them"
}

if [ "$UNINSTALL" -eq 1 ]; then do_uninstall; else do_install; fi
