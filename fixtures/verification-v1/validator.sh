#!/bin/sh
set -eu
case "$1" in
  positive)
    test "$(cat fixtures/verification-v1/input.json)" = '{"customer":"example","request":"book"}'
    result="$(sh fixtures/verification-v1/product-double.sh positive)"
    test "$result" = booking-created
    ;;
  denied)
    result="$(sh fixtures/verification-v1/product-double.sh denied)"
    test "$result" = denied
    ;;
  *) exit 1 ;;
esac
printf '%s\n' "$result"
