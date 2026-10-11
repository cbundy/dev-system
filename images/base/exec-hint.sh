# shellcheck shell=bash
# Sourced by dev-login and dev-remote-control (cbundy/dev-system#98).
#
# exec_hint <cmd>: how to run a command in this container from outside, for the
# hints. Coder first (a Coder workspace is reached with `coder ssh`, even when it
# runs on Kubernetes), then Kubernetes, then Docker. The hostname is the container
# ID under Docker and the pod name on Kubernetes.
exec_hint() {
  local host="${HOSTNAME:-$(cat /etc/hostname)}" ns coder_ws="${DEV_CODER_WORKSPACE:-${CODER_WORKSPACE_NAME:-}}"
  if [ -n "$coder_ws" ]; then
    echo "coder ssh $coder_ws -- $1"
  elif [ -n "${KUBERNETES_SERVICE_HOST:-}" ]; then
    ns=$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace 2>/dev/null || true)
    echo "kubectl exec -it${ns:+ -n $ns} $host -- $1"
  else
    echo "docker exec -it $host $1"
  fi
}
