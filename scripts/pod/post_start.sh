#!/bin/bash
# Installed at /post_start.sh: the RunPod image's /start.sh runs it on every container start,
# so a pod restart brings the app back by itself.
nohup bash /root/it/scripts/pod/boot.sh >> /root/supervise.log 2>&1 < /dev/null &
