#!/bin/sh
set -eu
case "$1" in
  positive) printf 'booking-created\n' ;;
  denied) printf 'denied\n' ;;
  *) exit 1 ;;
esac
