#!/bin/sh -x

KILL_CMD=pkill
CONFIG_FILE=$(hostname)-config.json

$KILL_CMD node

if [ ! -d logs ]; then
  mkdir logs
fi

nohup ./server.js $CONFIG_FILE 2>&1 | svlogd logs &
