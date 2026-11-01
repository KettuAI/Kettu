#!/bin/sh
# The daemon package's bin/kettu: runs the kettu CLI on the Node.js that comes with it. The install
# script links ~/.local/bin/kettu here, so the link is followed to find the package.
set -eu

self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
package=$(cd "$(dirname "$self")/.." && pwd -P)

exec "$package/node/bin/node" "$package/daemon/main.cjs" "$@"
