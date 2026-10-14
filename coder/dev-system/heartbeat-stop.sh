#!/bin/sh
# The agent's stop script: coder_script.heartbeat_stop in main.tf.
hb=/usr/local/share/dev-system/heartbeat-loop
if [ -x "$hb" ]; then
  timeout 10 "$hb" --final || true
fi
exit 0
