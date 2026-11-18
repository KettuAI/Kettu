#!/bin/sh
# Uninstalls the Kettu daemon that the install script installed for this user, without root. Kettu
# runs it over SSH in `sh -s`, so it works whatever version is installed:
#
#   1. stops and removes the service with the installed `kettu service uninstall`;
#   2. deletes ~/.local/bin/kettu, when it links into ~/.local/share/kettu/versions, and that
#      versions folder;
#   3. with --data, deletes the daemon's data and log folders too, as the daemon names them: its
#      sessions, settings and identity.
#
# Agents' own sign-ins, such as ~/.claude, and projects are never touched. A kettu that the install
# script did not install is left alone, and so is everything else then.
set -eu

mark=kettu-uninstall
data=0

say() { printf '%s\n' "$*"; }
fail() {
  printf 'kettu uninstall: %s\n' "$*" >&2
  exit 1
}
# The daemon trims these variables before it reads them.
trimmed() { printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
foreign() {
  printf '%s foreign %s\n' "$mark" "$1"
  fail "$1 was not installed by Kettu's install script, so it is left as it is; nothing was removed"
}
# Deletes a folder of Kettu's, never the home folder or one named in a roundabout way.
remove() {
  case $1 in
    '' | / | "$HOME" | "$HOME"/ | */../* | */.. | */./* | */.) fail "Refusing to delete $1" ;;
    /*) ;;
    *) fail "Refusing to delete $1, which is not an absolute path" ;;
  esac
  if [ -e "$1" ]; then
    rm -rf "$1"
    say "Deleted $1"
  fi
}

while [ $# -gt 0 ]; do
  case $1 in
    --data)
      data=1
      shift
      ;;
    *) fail "Unknown option $1" ;;
  esac
done
[ -n "${HOME:-}" ] || fail 'HOME is not set'
case $HOME in
  /*) ;;
  *) fail 'HOME is not an absolute path' ;;
esac

# Where the install script puts them.
share=${XDG_DATA_HOME:-}
case $share in
  /*) ;;
  *) share=$HOME/.local/share ;;
esac
versions=$share/kettu/versions
link=$HOME/.local/bin/kettu

kettu=''
if [ -L "$link" ]; then
  target=$(readlink "$link")
  case $target in
    "$versions"/*/bin/kettu) kettu=$target ;;
    *) foreign "$link" ;;
  esac
  [ -x "$kettu" ] || fail "$link links to $kettu, which is missing; nothing was removed"
elif [ -e "$link" ]; then
  foreign "$link"
elif other=$(command -v kettu 2> /dev/null) && [ -n "$other" ]; then
  foreign "$other"
fi

if [ -n "$kettu" ]; then
  "$kettu" service uninstall || fail 'Could not remove the service; nothing else was removed'
  # A daemon run by hand, as with kettu run, would keep running from the files deleted next.
  if "$kettu" status > /dev/null 2>&1; then
    printf '%s running\n' "$mark"
    fail 'A Kettu daemon still runs here outside its service, as kettu run does; stop it and try again. Only the service was removed'
  fi
  rm -f "$link"
  say "Deleted $link"
fi
remove "$versions"

if [ "$data" = 1 ]; then
  # As src/daemon/paths.ts names them.
  override=$(trimmed "${KETTU_DAEMON_DATA:-}")
  if [ -n "$override" ]; then
    case $override in
      /*) folder=$override ;;
      *) folder=$PWD/$override ;;
    esac
    logs=$folder/logs
  elif [ "$(uname -s)" = Darwin ]; then
    folder="$HOME/Library/Application Support/Kettu Daemon"
    logs="$HOME/Library/Logs/Kettu Daemon"
  else
    xdg=$(trimmed "${XDG_DATA_HOME:-}")
    case $xdg in
      /*) ;;
      *) xdg=$HOME/.local/share ;;
    esac
    state=$(trimmed "${XDG_STATE_HOME:-}")
    case $state in
      /*) ;;
      *) state=$HOME/.local/state ;;
    esac
    folder=$xdg/kettu
    logs=$state/kettu/logs
  fi
  remove "$folder"
  remove "$logs"
fi

printf '%s done\n' "$mark"
