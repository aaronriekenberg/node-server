#!/bin/sh -x

KILL_CMD=pkill
CONFIG_FILE=config/$(hostname)-config.json

$KILL_CMD node

sleep 2

if [ ! -d logs ]; then
  mkdir logs
fi

export NODE_ENV=production
nohup ./server.js $CONFIG_FILE 2>&1 | svlogd logs &
