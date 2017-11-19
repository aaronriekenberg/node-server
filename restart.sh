#!/bin/sh -x

KILL_CMD=killall
CONFIG_FILE=./raspberrypi-config.json

$KILL_CMD node

if [ -f output ]; then
  mv output output.1
fi

nohup ./server.js $CONFIG_FILE > output 2>&1 &
