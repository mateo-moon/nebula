set -eu
root=${HOST_ROOT:-/host}
admin=--admindir=$root/var/lib/dpkg
case "$FREEZE" in
  on) selection=hold want=hi ;;
  off) selection=install want=ii ;;
  *) echo "FREEZE must be on or off, not '$FREEZE'" >&2; exit 2 ;;
esac

check() {
  for p in $HOLD_PACKAGES; do
    if ! state=$(dpkg-query "$admin" -W -f='${db:Status-Abbrev}' "$p"); then
      echo "$p: not installed" >&2
      return 1
    fi
    case "$state" in
      "$want"*) echo "$p: $state" ;;
      *) echo "$p: dpkg state '$state', want '$want'" >&2; return 1 ;;
    esac
  done
  [ "$FREEZE" = on ] || return 0
  for entry in $FROZEN_FILES; do
    path=${entry%=*} sum=${entry##*=}
    if ! actual=$(sha256sum "$root/$path"); then
      echo "/$path: missing" >&2
      return 1
    fi
    actual=${actual%% *}
    if [ "$actual" != "$sum" ]; then
      echo "/$path: sha256 $actual, frozen $sum" >&2
      return 1
    fi
    echo "/$path: OK"
  done
}

case "${1:-}" in
  apply)
    printf "%s $selection\n" $HOLD_PACKAGES | dpkg "$admin" --set-selections
    check
    ;;
  check) check ;;
  *) echo "usage: freeze.sh apply|check" >&2; exit 2 ;;
esac
