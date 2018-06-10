#!/usr/bin/env node

'use strict';

const child_process = require('child_process');
const escapeHtml = require('escape-html');
const fs = require('fs');
const http2 = require('http2');
const process = require('process');
const util = require('util');
const winston = require('winston');
const asyncExec = util.promisify(child_process.exec);
const asyncReadFile = util.promisify(fs.readFile);

const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      timestamp: () => {
        return new Date().toISOString();
      },
      formatter: (options) => {
        return options.timestamp() + ' ' +
          options.level.toUpperCase() + ' ' +
          (options.message ? options.message : '') +
          (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '');
      }
    })
  ]
});

class AsyncServer {

constructor(configuration) {
  this.configuration = configuration;

  this.urlToHandler = new Map();

  this.urlToHandler.set('/', AsyncServer.buildIndexHandler(configuration));

  this.configuration.commandList.forEach(
    command => this.urlToHandler.set(command.httpPath, AsyncServer.buildCommandHandler(command)));

  this.configuration.staticFileList.forEach(
    staticFile => this.urlToHandler.set(staticFile.httpPath, AsyncServer.buildStaticFileHandler(staticFile)));
}

static buildIndexHandler(configuration) {

  function buildLiForCommand(command) {
    return `<li><a href="${command.httpPath}">${command.description}</a></li>`;
  }

  function buildLiForStaticFile(staticFile) {
    return `<li><a href="${staticFile.httpPath}">${staticFile.filePath}</a></li>`;
  }

  function buildStaticFilesBlock() {
    const staticFilesInMainPage =
      configuration.staticFileList.filter(sf => sf.includeInMainPage);
    if (staticFilesInMainPage.length === 0) {
      return '';
    } else {
      const staticFilesBlockHtml =
`
  <h3>Static Paths:</h3>
  <ul>
    ${staticFilesInMainPage.map(buildLiForStaticFile).join('\n    ')}
  </ul>
`;
      return staticFilesBlockHtml;
    }
  }

  const indexHtml =
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
    ${configuration.commandList.map(buildLiForCommand).join('\n    ')}
  </ul>
  ${buildStaticFilesBlock()}
</body>
</html>
`;

  return function(response) {
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end(indexHtml);
  };
}

static buildCommandHandler(command) {
  return async function(response) {
    let preString;
    try {
      const { stdout, stderr } = await asyncExec(command.command);
      preString = `Now: ${new Date().toISOString()}\n\n`;
      preString += `$ ${command.command}\n\n`;
      preString += escapeHtml(stderr + stdout);
    } catch (err) {
      logger.error('command err = ' + err);
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
  };
}

static buildStaticFileHandler(staticFile) {
  return async function(response) {
    try {
      const data = await asyncReadFile(staticFile.filePath);
      response.writeHead(200, staticFile.headers);
      response.end(data);
    } catch (err) {
      logger.error('static file err = ' + err);
      response.writeHead(404);
      response.end();
    }
  }
}

static serveNotFound(response) {
  response.writeHead(404, {'Content-Type': 'text/plain'});
  response.end('Unknown path');
}

start() {
  const serverOptions = {
    key: fs.readFileSync(this.configuration.tlsKeyFile),
    cert: fs.readFileSync(this.configuration.tlsCertFile)
  };

  const requstHandler =
    (request, response) => {
      const startTimeMS = Date.now();

      const remoteAddress = request.socket.remoteAddress;
      const remotePort = request.socket.remotePort;

      response.on('finish', () => {
        const durationMS = Date.now() - startTimeMS;
        logger.info(
          `${remoteAddress}:${remotePort} ` +
          `${request.method} ${request.url} ${response.statusCode} ${durationMS}ms`);
      });

      try {
        const handler = this.urlToHandler.get(request.url);
        if (handler) {
          handler(response);
        } else {
          AsyncServer.serveNotFound(response);
        }
      } catch (err) {
        logger.error('handler err = ' + err);
        response.stream.close();
      }
    };

  const httpServer = http2.createSecureServer(serverOptions, requstHandler);

  httpServer.on('error', (err) => logger.error('httpServer error err = ' + err));

  const listenOptions = {
    host: this.configuration.listenAddress,
    port: this.configuration.listenPort
  };

  httpServer.listen(
    listenOptions,
    () => logger.info(`server is listening on ${this.configuration.listenAddress + ':' + this.configuration.listenPort}`));
}

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
