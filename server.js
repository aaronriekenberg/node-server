#!/usr/bin/env node

'use strict';

const child_process = require('child_process');
const escapeHtml = require('escape-html');
const fecha = require('fecha');
const fs = require('fs');
const http2 = require('http2');
const process = require('process');
const util = require('util');
const winston = require('winston');
const asyncExec = util.promisify(child_process.exec);

const dateTimeFormat = 'YYYY-MM-DD[T]HH:mm:ss.SSSZZ';

const formattedDateTime = () => {
  return fecha.format(new Date(), dateTimeFormat);
};

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({
      format: dateTimeFormat
    }),
    winston.format.printf(info => {
      return `${info.timestamp} ${info.level}: ${info.message}`;
    })
  ),
  transports: [new winston.transports.Console()]
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

static getRemoteAddressPort(stream) {
  if (stream.session) {
    return `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}`;
  } else {
    return 'UNKNOWN';
  }
}

static destroyStream(stream) {
  try {
    if (!stream.destroyed) {
      stream.destroy();
    }
  } catch (err) {
    logger.error('destroyStream error err = ' + err);
  }
}

static writeResponse(stream, headers, body) {
  try {
    if (stream.destroyed) {
      logger.info(`stream destroyed sid=${stream.id}`);
      return;
    }

    stream.respond(headers);
    stream.end(body);

    logger.info(`<<< ${AsyncServer.getRemoteAddressPort(stream)} sid=${stream.id} status ${headers[':status']}`);
  } catch (err) {
    logger.error('writeResponse error err = ' + err);
    AsyncServer.destroyStream(stream);
  }
}

static buildIndexHandler(configuration) {

  const buildLiForCommand = (command) => {
    return `<li><a href="${command.httpPath}">${command.description}</a></li>`;
  }

  const buildLiForStaticFile = (staticFile) => {
    return `<li><a href="${staticFile.httpPath}">${staticFile.filePath}</a></li>`;
  }

  const buildStaticFilesBlock = () => {
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

  return (stream) => {
    AsyncServer.writeResponse(
      stream,
      {':status': 200, 'content-type': 'text/html'},
      indexHtml);
  };
}

static buildCommandHandler(command) {
  return async (stream) => {
    let preString;
    try {
      const { stdout, stderr } = await asyncExec(command.command);
      preString = `Now: ${formattedDateTime()}\n\n`;
      preString += `$ ${command.command}\n\n`;
      preString += escapeHtml(stderr + stdout);
    } catch (err) {
      logger.error('command err = ' + err);
      preString = escapeHtml(err);
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
  return (stream) => {
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
      stream.respondWithFile(staticFile.filePath,
                             responseHeaders,
                             {statCheck, onError});

      logger.info(`<<< ${AsyncServer.getRemoteAddressPort(stream)} sid=${stream.id} respondWithFile ${staticFile.filePath}`);
    } catch (err) {
      logger.error('respondWithFile error err = ' + err);
      AsyncServer.destroyStream(stream);
    }
  }
}

static serveNotFound(stream) {
  AsyncServer.writeResponse(
    stream,
    {':status': 404, 'content-type': 'text/plain'},
    'Unknown request');
}

start() {
  const serverOptions = {
    key: fs.readFileSync(this.configuration.tlsKeyFile),
    cert: fs.readFileSync(this.configuration.tlsCertFile)
  };

  const httpServer = http2.createSecureServer(serverOptions);

  httpServer.on('error', (err) => logger.error('httpServer error err = ' + err));

  httpServer.on('stream', (stream, headers) => {
    const method = headers[':method'];
    const path = headers[':path'];

    logger.info(`>>> ${AsyncServer.getRemoteAddressPort(stream)} sid=${stream.id} ${method} ${path}`);

    let handled = false;
    if (method === 'GET') {
      const handler = this.pathToHandler.get(path);
      if (handler) {
        handler(stream);
        handled = true;
      }
    }
    if (!handled) {
      AsyncServer.serveNotFound(stream);
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

const main = () => {
  if (process.argv.length !== 3) {
    console.log("Usage: " + process.argv[1] + " <config json>");
    process.exit(1);
  }

  const configuration = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  logger.info("configuration = " + JSON.stringify(configuration, null, 2));

  const asyncServer = new AsyncServer(configuration);
  asyncServer.start();
}

main();
