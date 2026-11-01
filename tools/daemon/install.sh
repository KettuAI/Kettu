#!/bin/sh
# Installs the Kettu daemon for this user, without root:
#
#   curl -fsSL https://kettu.sh/install | sh
#
# It downloads the package for this system from Kettu's GitHub releases, checks it against the
# release's checksums, unpacks it into ~/.local/share/kettu/versions/<version>, links
# ~/.local/bin/kettu to it and sets up the daemon's service. `kettu update` runs it again for a
# newer release. Pass options after `sh -s --`:
#
#   --version <version>  Install that release instead of the latest
#   --no-service         Do not set up the service, as in a container; run `kettu run` instead
#
# KETTU_RELEASES_URL names another place to download releases from, laid out as GitHub's.
set -eu

releases=${KETTU_RELEASES_URL:-https://github.com/KettuAI/Kettu/releases}
wanted=''
service=1

say() { printf '%s\n' "$*"; }
fail() {
  printf 'kettu install: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --version)
      [ $# -ge 2 ] || fail '--version needs a version, such as 0.1.0'
      wanted=$2
      shift 2
      ;;
    --version=*)
      wanted=${1#--version=}
      shift
      ;;
    --no-service)
      service=0
      shift
      ;;
    -h | --help)
      sed -n '2,15s/^# \{0,1\}//p' "$0" 2>/dev/null || say 'See https://kettu.sh/install'
      exit 0
      ;;
    *) fail "Unknown option $1" ;;
  esac
done
wanted=${wanted#v}
case $wanted in
  '' | [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "'$wanted' is not a version, such as 0.1.0" ;;
esac
[ -n "${HOME:-}" ] || fail 'HOME is not set'

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail 'The Kettu daemon runs on Linux and macOS' ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "The Kettu daemon has no package for $(uname -m) processors" ;;
esac
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  # A shell under Rosetta reports x86_64 on Apple silicon.
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  else
    fail 'The Kettu daemon runs on Macs with Apple silicon'
  fi
fi
if [ "$os" = linux ]; then
  case $(ldd --version 2>&1 || true) in
    *musl*) fail 'The Kettu daemon needs glibc; systems with musl, such as Alpine, are not supported' ;;
  esac
fi

if command -v curl > /dev/null 2>&1; then
  download() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget > /dev/null 2>&1; then
  download() { wget -q -O "$2" "$1"; }
else
  fail 'Downloading needs curl or wget'
fi
if command -v sha256sum > /dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum > /dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  fail 'Checking the download needs sha256sum or shasum'
fi

share=${XDG_DATA_HOME:-}
case $share in
  /*) ;;
  *) share=$HOME/.local/share ;;
esac
versions=$share/kettu/versions
bin=$HOME/.local/bin
link=$bin/kettu

# A link of ours, or nothing: another program's kettu stays where it is.
previous=''
if [ -L "$link" ]; then
  previous=$(readlink "$link")
  case $previous in
    "$versions"/*/bin/kettu) previous=${previous%/bin/kettu} ;;
    *) fail "$link links to $previous, not to a Kettu daemon; move it and run this again" ;;
  esac
elif [ -e "$link" ]; then
  fail "$link is not the Kettu daemon's; move it and run this again"
fi

mkdir -p "$versions"
# Unpacked beside the versions, so the package moves into place with a rename.
work=$(mktemp -d "$versions/.install.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

file=kettu-daemon-$os-$arch.tar.gz
if [ -n "$wanted" ]; then
  from=$releases/download/v$wanted
else
  from=$releases/latest/download
fi
say "Downloading $file"
download "$from/$file" "$work/$file" || fail "Could not download $from/$file"
download "$from/kettu-daemon-sha256sums.txt" "$work/sums" ||
  fail "Could not download $from/kettu-daemon-sha256sums.txt"
expected=$(awk -v name="$file" '$2 == name || $2 == "*" name { print $1; exit }' "$work/sums")
[ -n "$expected" ] || fail "The release's checksums list no $file; nothing was installed"
actual=$(sha256 "$work/$file")
if [ "$actual" != "$expected" ]; then
  fail "$file does not match the release's checksum; nothing was installed"
fi

tar -xzf "$work/$file" -C "$work"
package=$work/kettu-daemon-$os-$arch
[ -x "$package/bin/kettu" ] || fail "$file holds no bin/kettu; nothing was installed"
if ! version=$("$package/bin/kettu" --version 2>&1); then
  printf '%s\n' "$version" >&2
  if [ "$os" = linux ]; then say 'The Kettu daemon needs glibc 2.28 or later.' >&2; fi
  fail 'This computer cannot run the Kettu daemon; nothing was installed'
fi
case $version in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "The package reports '$version' as its version; nothing was installed" ;;
esac
if [ -n "$wanted" ] && [ "$version" != "$wanted" ]; then
  fail "The package for $wanted reports $version; nothing was installed"
fi

target=$versions/$version
if [ -e "$target" ]; then mv "$target" "$work/replaced"; fi
mv "$package" "$target"
mkdir -p "$bin"
ln -s "$target/bin/kettu" "$work/link"
mv -f "$work/link" "$link"

# The version before stays, to go back to; older ones go.
if [ -n "$previous" ] && [ "$previous" != "$target" ]; then
  for dir in "$versions"/*; do
    case $dir in
      "$target" | "$previous") ;;
      *) if [ -d "$dir" ]; then rm -rf "$dir"; fi ;;
    esac
  done
fi

say "Installed the Kettu daemon $version in $target"
case :$PATH: in
  *:"$bin":*) ;;
  *)
    say "$bin is not on your PATH. Add it in your shell's profile, such as ~/.profile:"
    say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

if [ "$service" = 1 ]; then
  if ! "$target/bin/kettu" service install; then
    fail 'The daemon is installed, but its service is not set up; run kettu service install again, or kettu run in the foreground'
  fi
else
  say 'Start it with kettu run, or set up its service with kettu service install.'
fi
