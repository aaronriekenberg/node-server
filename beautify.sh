#!/bin/sh -x

./node_modules/.bin/js-beautify  -s 2 -r server.js ./config/*.json
