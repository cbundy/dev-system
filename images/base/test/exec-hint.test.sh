#!/bin/sh
# shellcheck disable=SC2016 # the bash -c script is single-quoted on purpose
# Plain-shell test for images/base/exec-hint.sh (cbundy/dev-system#98): the hint is
# `coder ssh` on Coder (which wins over Kubernetes), else kubectl, else docker.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
LIB="$SCRIPT_DIR/../exec-hint.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[ -f "$LIB" ] || fail "$LIB is missing"

# hint <expected> <label> [VAR=value...]: run exec_hint with only those Coder/k8s vars set.
hint() {
  expected=$1 label=$2
  shift 2
  got=$(env -u DEV_CODER_WORKSPACE -u CODER_WORKSPACE_NAME -u KUBERNETES_SERVICE_HOST \
    HOSTNAME=testbox "$@" bash -c '. "$1"; exec_hint "dev-login <code>"' _ "$LIB")
  [ "$got" = "$expected" ] || fail "$label: expected '$expected', got '$got'"
}

hint 'coder ssh ws1 -- dev-login <code>' "DEV_CODER_WORKSPACE" DEV_CODER_WORKSPACE=ws1
hint 'coder ssh ws2 -- dev-login <code>' "CODER_WORKSPACE_NAME only" CODER_WORKSPACE_NAME=ws2
hint 'coder ssh ws1 -- dev-login <code>' "both set" DEV_CODER_WORKSPACE=ws1 CODER_WORKSPACE_NAME=ws2
hint 'coder ssh ws1 -- dev-login <code>' "coder beats kubernetes" DEV_CODER_WORKSPACE=ws1 KUBERNETES_SERVICE_HOST=10.0.0.1
hint 'kubectl exec -it testbox -- dev-login <code>' "kubernetes" KUBERNETES_SERVICE_HOST=10.0.0.1
hint 'docker exec -it testbox dev-login <code>' "docker"
hint 'docker exec -it testbox dev-login <code>' "empty DEV_CODER_WORKSPACE" DEV_CODER_WORKSPACE=
hint 'coder ssh ws2 -- dev-login <code>' "empty DEV_CODER_WORKSPACE falls to CODER_WORKSPACE_NAME" DEV_CODER_WORKSPACE= CODER_WORKSPACE_NAME=ws2

echo "exec-hint: ok"
