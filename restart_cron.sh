#!/bin/sh

pgrep node > /dev/null 2>&1
if [ $? -eq 1 ]; then
  cd /home/pi/node-server
  ./restart.sh > /dev/null 2>&1
fi
