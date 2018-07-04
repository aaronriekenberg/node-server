#!/usr/bin/env node

'use strict';

const child_process = require('child_process');
const fecha = require('fecha');
const fs = require('fs');
const git = require('simple-git/promise');
const http2 = require('http2');
const mustache = require('mustache');
const process = require('process');
const util = require('util');
const winston = require('winston');
const asyncExec = util.promisify(child_process.exec);
const readFileAsync = util.promisify(fs.readFile);

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
  let streamIDString;

  if (stream.session && stream.session.socket) {
    streamIDString = `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}`;
  } else {
    streamIDString = 'UNKNOWN';
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

get deltaTime() {
  const delta = process.hrtime(this.startTime);
  return (delta[0] + (delta[1] / 1e9));
}

get streamDestroyed() {
  return this.stream.destroyed;
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
    if (this.streamDestroyed) {
      logger.info(`${this.streamIDString} writeResponse stream destroyed`);
      return;
    }

    if (!body) {
      this.stream.respond(responseHeaders, {endStream: true});
    } else {
      this.stream.respond(responseHeaders);
      this.stream.end(body);
    }

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
    if (this.streamDestroyed) {
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

constructor(configuration, templates) {
  this.configuration = configuration;
  this.templates = templates;

  this.pathToHandler = new Map();

  const setOrThrow = (key, value) => {
    if (this.pathToHandler.has(key)) {
      throw new Error(`duplicate path key ${key}`);
    }
    this.pathToHandler.set(key, value);
  };

  setOrThrow('/', AsyncServer.buildIndexHandler(this.templates.index, this.configuration));

  this.configuration.commandList.forEach(
    (command) => setOrThrow(command.httpPath, AsyncServer.buildCommandHandler(this.templates.command, command)));

  this.configuration.staticFileList.forEach(
    (staticFile) => setOrThrow(staticFile.httpPath, AsyncServer.buildStaticFileHandler(staticFile)));

  logger.info(`pathToHandler.size = ${this.pathToHandler.size}`);
}

static buildIndexHandler(template, configuration) {
  const staticFilesInMainPage = configuration.staticFileList.filter((sf) => sf.includeInMainPage);

  const indexData = {
    now: formattedDateTime(),
    staticFilesInMainPage,
    configuration
  };

  const indexHtml = mustache.render(template, indexData);

  return (requestContext) => {
    requestContext.writeResponse(
      {':status': 200, 'content-type': 'text/html'},
      indexHtml);
  };
}

static buildCommandHandler(template, command) {
  return async (requestContext) => {
    let childProcess;
    let commandErr;
    try {
      childProcess = await asyncExec(command.command);
    } catch (err) {
      logger.error('command err = ' + err);
      commandErr = err;
    }

    if (requestContext.streamDestroyed) {
      logger.info(`${requestContext.streamIDString} stream destroyed after command`);
      return;
    };

    let commandOutput;
    if (commandErr) {
      commandOutput = commandErr;
    } else {
      commandOutput = childProcess.stderr + childProcess.stdout;
    }

    const commandData = {
      now: formattedDateTime(),
      command,
      commandOutput
    };

    const commandHtml = mustache.render(template, commandData);

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

async createHttpServer() {
  const httpServerConfig = {};
  [httpServerConfig.key, httpServerConfig.cert] = await Promise.all([
    readFileAsync(this.configuration.tlsKeyFile),
    readFileAsync(this.configuration.tlsCertFile)
  ]);
  return http2.createSecureServer(httpServerConfig);
}

async start() {
  const httpServer = await this.createHttpServer();

  httpServer.on('error', (err) => logger.error('httpServer error err = ' + err));

  httpServer.on('listening', () => logger.info(`httpServer listening on ${JSON.stringify(httpServer.address())}`));

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
  });
}

}

const getGitHash = async () => {
  logger.info('getGitHash');
  const gitLog = await git('.').log(['-1']);
  return gitLog.latest.hash;
}

const readConfiguration = async (configFilePath) => {
  logger.info('readConfiguration ' + configFilePath);
  const [fileContent, gitHash] = await Promise.all([
    readFileAsync(configFilePath, 'utf8'),
    getGitHash()
  ]);

  const configuration = JSON.parse(fileContent);
  configuration.gitHash = gitHash;

  return configuration;
}

const readTemplates = async () => {
  logger.info('readTemplates');
  const templates = {};
  [templates.index, templates.command] = await Promise.all([
    readFileAsync('templates/index.mustache', 'utf8'),
    readFileAsync('templates/command.mustache', 'utf8')
  ]);
  Object.values(templates).forEach((t) => mustache.parse(t));
  return templates;
}

const main = async () => {
  if (process.argv.length !== 3) {
    console.log("Usage: " + process.argv[1] + " <config json>");
    process.exit(1);
  }

  let configuration;
  let templates;
  try {
    [configuration, templates] = await Promise.all([
      readConfiguration(process.argv[2]),
      readTemplates()
    ]);
  } catch (err) {
    logger.error('error reading data at startup err = ' + err);
    process.exit(1);
  }
  logger.info("configuration = " + JSON.stringify(configuration, null, 2));

  try {
    await new AsyncServer(configuration, templates).start();
  } catch (err) {
    logger.error('error starting server err = ' + err);
    process.exit(1);
  }
}

main();
