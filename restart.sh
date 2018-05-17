#!/bin/sh -x

KILL_CMD=pkill
CONFIG_FILE=$(hostname)-config.json

$KILL_CMD node

nohup ./server.js $CONFIG_FILE 2>&1 | svlogd logs &
