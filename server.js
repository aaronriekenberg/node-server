#!/usr/bin/env node

'use strict';

const child_process = require('child_process');
const escapeHtml = require('escape-html');
const fs = require('fs');
const http = require('http');
const process = require('process');
const util = require('util');
const winston = require('winston');
const asyncExec = util.promisify(child_process.exec);
const asyncReadFile = util.promisify(fs.readFile);

const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      timestamp: function() {
        return new Date().toISOString();
      },
      formatter: function(options) {
        return options.timestamp() + ' ' +
          options.level.toUpperCase() + ' ' +
          (options.message ? options.message : '') +
          (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '');
      }
    })
  ]
});

function AsyncServer(configuration) {
  this.configuration = configuration;

  this.commandMap = new Map();
  configuration.commandList.forEach(command => this.commandMap.set(command.httpPath, command));

  this.staticFileMap = new Map();
  configuration.staticFileList.forEach(staticFile => this.staticFileMap.set(staticFile.httpPath, staticFile));

  this.indexHtml = AsyncServer.buildIndexHtml(configuration);
}

AsyncServer.buildIndexHtml = function(configuration) {

  function buildLiForCommand(command) {
    return `<li><a href="${command.httpPath}">${command.description}</a></li>`;
  }

  let indexHtml =
`<!DOCTYPE html>
<html>
<head>
  <title>${configuration.mainPageTitle}</title>
  <meta name="viewport" content="width=device, initial-scale=1" />
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h2>${configuration.mainPageTitle}</h2>
  <h3>Commands:</h3>
  <ul>
    ${configuration.commandList.map(command => buildLiForCommand(command)).join('\n    ')}
  </ul>
</body>
</html>
`;

  return indexHtml;
}

AsyncServer.prototype.serveIndex = function(response) {
  response.writeHead(200, {'Content-Type': 'text/html'});
  response.end(this.indexHtml);
}

AsyncServer.prototype.serveCommand = async function(command, response) {
  let preString;
  try {
    const { stdout, stderr } = await asyncExec(command.command);
    preString = `Now: ${new Date().toISOString()}\n\n`;
    preString += `$ ${command.command}\n\n`;
    preString += escapeHtml(stderr + stdout);
  } catch (err) {
    preString = err;
  }

  const commandHtml =
`<!DOCTYPE html>
<html>
<head>
  <title>${command.description}</title>
  <meta name="viewport" content="width=device, initial-scale=1" />
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <a href="..">..</a>
  <pre>${preString}</pre>
</body>
</html>
`;

  response.writeHead(200, {'Content-Type': 'text/html'});
  response.end(commandHtml);
}

AsyncServer.prototype.serveFile = async function(staticFile, response) {
  try {
    const data = await asyncReadFile(staticFile.filePath);
    response.writeHead(200, staticFile.headers);
    response.end(data);
  } catch (err) {
    logger.error('serveFile err = ' + err);
    response.writeHead(404);
    response.end();
  }
}

AsyncServer.prototype.serveNotFound = function(response) {
  response.writeHead(404, {'Content-Type': 'text/plain'});
  response.end('Unknown path');
}

AsyncServer.prototype.start = function() {
  const asyncServer = this;

  const httpServer = http.createServer(async function(request, response) {
    const startTimeMS = new Date().getTime();

    response.on('finish', function() {
      const durationMS = new Date().getTime() - startTimeMS;
      logger.info(`${request.socket.remoteAddress}:${request.socket.remotePort} ${request.method} ${request.url} ${response.statusCode} ${durationMS}ms`);
    });

    if (request.url === '/') {
      asyncServer.serveIndex(response);
    } else if (asyncServer.commandMap.has(request.url)) {
      const command = asyncServer.commandMap.get(request.url);
      await asyncServer.serveCommand(command, response);
    } else if (asyncServer.staticFileMap.has(request.url)) {
      const staticFile = asyncServer.staticFileMap.get(request.url);
      await asyncServer.serveFile(staticFile, response);
    } else {
      asyncServer.serveNotFound(response);
    }
  });

  httpServer.listen(this.configuration.port, (err) => {
    if (err) {
      logger.error('something bad happened', err);
      return;
    }
    logger.info(`server is listening on ${asyncServer.configuration.port}`);
  });
}

function main() {
  if (process.argv.length != 3) {
    console.log("Usage: " + process.argv[1] + " <config json>");
    process.exit(1);
  }

  const configuration = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  logger.info("configuration = " + JSON.stringify(configuration, null, 2));

  const asyncServer = new AsyncServer(configuration);
  asyncServer.start();
}

main();
