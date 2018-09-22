#!/usr/bin/env node

'use strict';

const agentkeepalive = require('agentkeepalive');
const child_process = require('child_process');
const fecha = require('fecha');
const fs = require('fs');
const fsPromises = fs.promises;
const git = require('simple-git/promise');
const http = require('http');
const http2 = require('http2');
const mustache = require('mustache');
const process = require('process');
const util = require('util');
const winston = require('winston');
const asyncExec = util.promisify(child_process.exec);

const dateTimeFormat = 'YYYY-MM-DD[T]HH:mm:ss.SSSZZ';

const formattedDateTime = () => fecha.format(new Date(), dateTimeFormat);

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({
      format: dateTimeFormat
    }),
    winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [new winston.transports.Console()]
});

const formatError = (err) => (err.stack || err.message);

const readFileAsync = async (filePath, encoding = null) => {
  let fileHandle;
  try {
    fileHandle = await fsPromises.open(filePath, 'r');
    return await fileHandle.readFile({encoding});
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
};

let httpAgentInstance = () => {
  const instance = new agentkeepalive({
    keepAlive: true
  });
  httpAgentInstance = () => instance;
  return instance;
};

class RequestContext {

constructor(stream, requestHeaders) {
  this.startTime = process.hrtime();
  this.stream = stream;
  this.requestHeaders = requestHeaders;
  this.streamIDString = RequestContext.buildStreamIDString(stream);
}

static buildStreamIDString(stream) {
  try {
    return `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}/${stream.id}`;
  } catch (err) {
    return 'UNKNOWN';
  }
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
    logger.error(`destroyStream error err = ${formatError(err)}`);
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
    logger.error(`writeResponse error err = ${formatError(err)}`);
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
    logger.error(`respondWithFile error err = ${formatError(err)}`);
    this.destroyStream();
  }
}

}

class Handlers {

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
      logger.error(`command err = ${formatError(err)}`);
      commandErr = err;
    }

    if (requestContext.streamDestroyed) {
      logger.info(`${requestContext.streamIDString} stream destroyed after command`);
      return;
    }

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

static buildProxyHandler(template, proxy) {
  return (requestContext) => {

    let proxyResponseData = '';
    let proxyResponseStatus = '';
    let proxyResponseHeaders = '';
    let proxyError;

    let writeProxyResponse = () => {
      writeProxyResponse = () => {};
     
      if (requestContext.streamDestroyed) {
        logger.info(`${requestContext.streamIDString} stream destroyed after proxy`);
        return;
      }

      const proxyData = {
        now: formattedDateTime(),
        proxy,
        responseData: (proxyError || proxyResponseData),
        responseStatus: proxyResponseStatus,
        responseHeaders: proxyResponseHeaders
      };

      const proxyHtml = mustache.render(template, proxyData);

      requestContext.writeResponse(
        {':status': 200, 'content-type': 'text/html'},
        proxyHtml);
    };

    const requestOptions = Object.assign(
      { agent: httpAgentInstance() },
      proxy.options);

    const proxyRequest = http.request(requestOptions, (proxyResponse) => {
      proxyResponseStatus = proxyResponse.statusCode;
      proxyResponseHeaders = JSON.stringify(proxyResponse.headers, null, 2);

      proxyResponse.setEncoding('utf8');

      proxyResponse.on('data', (chunk) => {
        proxyResponseData += chunk;
      });

      proxyResponse.on('end', () => {
        writeProxyResponse();
      });
    });

    proxyRequest.on('error', (err) => {
      logger.error(`proxy err = ${formatError(err)}`);
      proxyError = err;
      writeProxyResponse();
    });

    proxyRequest.end();
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
        logger.error(`statCheck error err = ${formatError(err)}`);
      }
      return true;
    };

    const onError = (err) => {
      logger.error(`file onError err = ${formatError(err)}`);

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

static buildHttpAgentStatusHandler() {
  return (requestContext) => {
    const statusJson = JSON.stringify(httpAgentInstance().getCurrentStatus(), null, 2);

    requestContext.writeResponse(
      {':status': 200, 'content-type': 'text/plain'},
      statusJson);
  };
}

}

class AsyncServer {

constructor(configuration, templates) {
  this.configuration = configuration;

  this.pathToHandler = new Map();

  const setOrThrow = (key, value) => {
    if (this.pathToHandler.has(key)) {
      throw new Error(`duplicate path key ${key}`);
    }
    this.pathToHandler.set(key, value);
  };

  setOrThrow('/', Handlers.buildIndexHandler(templates.index, this.configuration));

  (this.configuration.commandList || []).forEach(
    (command) => setOrThrow(command.httpPath, Handlers.buildCommandHandler(templates.command, command)));

  (this.configuration.proxyList || []).forEach(
    (proxy) => setOrThrow(proxy.httpPath, Handlers.buildProxyHandler(templates.proxy, proxy)));

  (this.configuration.staticFileList || []).forEach(
    (staticFile) => setOrThrow(staticFile.httpPath, Handlers.buildStaticFileHandler(staticFile)));

  setOrThrow('/http_agent_status', Handlers.buildHttpAgentStatusHandler());

  logger.info(`pathToHandler.size = ${this.pathToHandler.size}`);
}

serveNotFound(requestContext) {
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

  httpServer.on('error', (err) => logger.error(`httpServer error err = ${formatError(err)}`));

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
      this.serveNotFound(requestContext);
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
};

const readConfiguration = async (configFilePath) => {
  logger.info(`readConfiguration '${configFilePath}'`);
  const [fileContent, gitHash] = await Promise.all([
    readFileAsync(configFilePath, 'utf8'),
    getGitHash()
  ]);

  const configuration = JSON.parse(fileContent);
  configuration.gitHash = gitHash;

  return configuration;
};

const readTemplates = async () => {
  logger.info('readTemplates');
  const templates = {};
  [templates.command, templates.index, templates.proxy] = await Promise.all([
    readFileAsync('templates/command.mustache', 'utf8'),
    readFileAsync('templates/index.mustache', 'utf8'),
    readFileAsync('templates/proxy.mustache', 'utf8')
  ]);
  Object.values(templates).forEach((t) => mustache.parse(t));
  return templates;
};

const main = async () => {
  if (process.argv.length !== 3) {
    throw new Error('config json path required as command line argument');
  }

  const [configuration, templates] = await Promise.all([
    readConfiguration(process.argv[2]),
    readTemplates()
  ]);

  logger.info(`configuration = ${JSON.stringify(configuration, null, 2)}`);

  const asyncServer = new AsyncServer(configuration, templates);
  await asyncServer.start();
};

main().catch((err) => {
  logger.error(`main error err = ${formatError(err)}`);
  process.exit(1);
});
