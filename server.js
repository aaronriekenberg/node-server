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

class RequestContext {

constructor(stream, requestHeaders) {
  this.startTime = process.hrtime();
  this.stream = stream;
  this.requestHeaders = requestHeaders;
  this.streamIDString = RequestContext.buildStreamIDString(stream);
}

static buildStreamIDString(stream) {
  let streamIDString = '';

  if (stream.session) {
    streamIDString += `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}`;
  } else {
    streamIDString += 'UNKNOWN';
  }

  streamIDString += `/${stream.id}`;
  return streamIDString;
}

get requestMethod() {
  return this.requestHeaders[':method'];
}

get requestPath() {
  return this.requestHeaders[':path'];
}

get streamID() {
  return this.stream.id;
}

get deltaTime() {
  const delta = process.hrtime(this.startTime);
  return (delta[0] + (delta[1] / 1e9));
}

destroyStream() {
  try {
    if (!this.stream.destroyed) {
      this.stream.destroy();
    }
  } catch (err) {
    logger.error('destroyStream error err = ' + err);
  }
}

writeResponse(responseHeaders, body = null) {
  try {
    if (this.stream.destroyed) {
      logger.info(`${this.streamIDString} writeResponse stream destroyed`);
      return;
    }

    this.stream.respond(responseHeaders);
    this.stream.end(body);

    logger.info(
      `${this.streamIDString} ${this.requestMethod} ${this.requestPath} ` +
      `status=${responseHeaders[':status']} ${this.deltaTime}s`);
  } catch (err) {
    logger.error('writeResponse error err = ' + err);
    this.destroyStream();
  }
}

respondWithFile(path, responseHeaders, options) {
  try {
    if (this.stream.destroyed) {
      logger.info(`${this.streamIDString} respondWithFile stream destroyed`);
      return;
    }
     
    this.stream.respondWithFile(path, responseHeaders, options);

    logger.info(
      `${this.streamIDString} ${this.requestMethod} ${this.requestPath} ` +
      `respondWithFile status=${responseHeaders[':status']} ${this.deltaTime}s`);
  } catch (err) {
    logger.error('respondWithFile error err = ' + err);
    this.destroyStream();
  }
}

}

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
  <hr>
  <small>Last Modified: ${formattedDateTime()}</small>
</body>
</html>
`;

  return (requestContext) => {
    requestContext.writeResponse(
      {':status': 200, 'content-type': 'text/html'},
      indexHtml);
  };
}

static buildCommandHandler(command) {
  return async (requestContext) => {
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

    requestContext.writeResponse(
      {':status': 200, 'content-type': 'text/html'},
      commandHtml);
  };
}

static buildStaticFileHandler(staticFile) {
  return (requestContext) => {

    const statCheck = (stat, statResponseHeaders) => {
      try {
        // resolution for http headers is 1 second
        stat.mtime.setMilliseconds(0);

        statResponseHeaders['last-modified'] = stat.mtime.toUTCString();

        const ifModifiedSinceString = requestContext.requestHeaders['if-modified-since'];
        if (ifModifiedSinceString) {
          const ifModifiedSinceDate = new Date(ifModifiedSinceString);
          if (stat.mtime.getTime() <= ifModifiedSinceDate.getTime()) {
            statResponseHeaders[':status'] = 304;
            requestContext.writeResponse(statResponseHeaders);
            return false;
          }
        }
      } catch (err) {
        logger.error('statCheck error err = ' + err);
      }
      return true;
    };

    const onError = (err) => {
      logger.error('file onError err = ' + err);

      if (err.code === 'ENOENT') {
        requestContext.writeResponse(
          {':status': 404, 'content-type': 'text/plain'},
          'File not found');
      } else {
        requestContext.writeResponse(
          {':status': 500, 'content-type': 'text/plain'},
          'Error reading file');
      }
    };

    const responseHeaders = Object.assign(
      {':status': 200},
      staticFile.headers);

    requestContext.respondWithFile(staticFile.filePath,
                                   responseHeaders,
                                   {statCheck, onError});
  }
}

static serveNotFound(requestContext) {
  requestContext.writeResponse(
    {':status': 404, 'content-type': 'text/plain'},
    'Unknown request');
}

start() {
  const httpServer = http2.createSecureServer({
      key: fs.readFileSync(this.configuration.tlsKeyFile),
      cert: fs.readFileSync(this.configuration.tlsCertFile)
    });

  httpServer.on('error', (err) => logger.error('httpServer error err = ' + err));

  httpServer.on('stream', (stream, headers) => {

    const requestContext = new RequestContext(stream, headers);

    let handled = false;
    if (requestContext.requestMethod === 'GET') {
      const handler = this.pathToHandler.get(requestContext.requestPath);
      if (handler) {
        handler(requestContext);
        handled = true;
      }
    }
    if (!handled) {
      AsyncServer.serveNotFound(requestContext);
    }

  });


  httpServer.listen({
      host: this.configuration.listenAddress,
      port: this.configuration.listenPort
    },
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
