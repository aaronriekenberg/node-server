#!/bin/sh -x

KILL_CMD=killall

$KILL_CMD node

if [ -f output ]; then
  mv output output.1
fi

nohup ./server.js > output 2>&1 &
