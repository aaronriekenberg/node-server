#!/usr/bin/env node

'use strict';

const child_process = require('child_process');
const escapeHtml = require('escape-html');
const fs = require('fs');
const http2 = require('http2');
const moment = require('moment');
const process = require('process');
const util = require('util');
const winston = require('winston');
const asyncExec = util.promisify(child_process.exec);

function formattedDateTime() {
  return moment().format('YYYY-MM-DD[T]HH:mm:ss.SSSZ');
}

const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      timestamp: () => {
        return formattedDateTime();
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

  this.pathToHandler = new Map();

  this.pathToHandler.set('/', AsyncServer.buildIndexHandler(configuration));

  this.configuration.commandList.forEach(
    command => this.pathToHandler.set(command.httpPath, AsyncServer.buildCommandHandler(command)));

  this.configuration.staticFileList.forEach(
    staticFile => this.pathToHandler.set(staticFile.httpPath, AsyncServer.buildStaticFileHandler(staticFile)));
}

static writeResponse(stream, headers, body) {
  try {
    const remoteAddress = stream.session.socket.remoteAddress;
    const remotePort = stream.session.socket.remotePort;

    stream.respond(headers);
    stream.end(body);

    logger.info(`<<< ${remoteAddress}:${remotePort} ${headers[':status']}`);
  } catch (err) {
    logger.error('writeResponse error err = ' + err);
    stream.session.destroy();
  }
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

  return function(stream) {
    AsyncServer.writeResponse(
      stream,
      {':status': 200, 'content-type': 'text/html'},
      indexHtml);
  };
}

static buildCommandHandler(command) {
  return async function(stream) {
    let preString;
    try {
      const { stdout, stderr } = await asyncExec(command.command);
      preString = `Now: ${formattedDateTime()}\n\n`;
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

    AsyncServer.writeResponse(
      stream,
      {':status': 200, 'content-type': 'text/html'},
      commandHtml);
  };
}

static buildStaticFileHandler(staticFile) {
  return function(stream) {
    const statCheck = (stat, headers) => {
      headers['last-modified'] = stat.mtime.toUTCString();
    };

    const onError = (err) => {
      logger.error('file onError err = ' + err);
      if (err.code === 'ENOENT') {
        stream.respond({':status': 404});
      } else {
        stream.respond({':status': 500});
      }
      stream.end();
    };

    const responseHeaders = {':status': 200};
    Object.assign(responseHeaders, staticFile.headers);

    try {
      const remoteAddress = stream.session.socket.remoteAddress;
      const remotePort = stream.session.socket.remotePort;

      stream.respondWithFile(staticFile.filePath,
                             responseHeaders,
                             {statCheck, onError});

      logger.info(`<<< ${remoteAddress}:${remotePort} respondWithFile ${staticFile.filePath}`);
    } catch (err) {
      logger.error('respondWithFile error err = ' + err);
      stream.session.destroy();
    }
  }
}

static serveNotFound(stream) {
  AsyncServer.writeResponse(
    stream,
    {':status': 404, 'content-type': 'text/plain'},
    'Unknown path');
}

start() {
  const serverOptions = {
    key: fs.readFileSync(this.configuration.tlsKeyFile),
    cert: fs.readFileSync(this.configuration.tlsCertFile)
  };

  const httpServer = http2.createSecureServer(serverOptions);

  httpServer.on('error', (err) => logger.error('httpServer error err = ' + err));

  httpServer.on('stream', (stream, headers) => {
    const remoteAddress = stream.session.socket.remoteAddress;
    const remotePort = stream.session.socket.remotePort;

    const method = headers[':method'];
    const path = headers[':path'];

    logger.info(`>>> ${remoteAddress}:${remotePort} ${method} ${path}`);

    if (method === 'GET') {
      const handler = this.pathToHandler.get(path);
      if (handler) {
        handler(stream);
      } else {
        AsyncServer.serveNotFound(stream);
      }
    }

  });

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
