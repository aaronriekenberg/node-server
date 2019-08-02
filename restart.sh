#!/bin/sh -x

CONFIG_FILE=config/$(hostname -s)-config.json

pkill -f 'node ./built/server.js'

sleep 2

if [ ! -d logs ]; then
  mkdir logs
fi

export NODE_ENV=production
nohup ./built/server.js $CONFIG_FILE >> logs/output 2>&1 &
