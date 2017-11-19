#!/usr/bin/env node

const child_process = require('child_process')
const escapeHtml = require('escape-html')
const fs = require('fs')
const http = require('http')
const process = require('process')
const util = require('util')
const winston = require('winston')
const asyncExec = util.promisify(child_process.exec)
const asyncReadFile = util.promisify(fs.readFile)

const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      timestamp: function() {
        return new Date().toISOString()
      },
      formatter: function(options) {
        return options.timestamp() + ' ' +
          options.level.toUpperCase() + ' ' +
          (options.message ? options.message : '') +
          (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '')
      }
    })
  ]
});

if (process.argv.length != 3) {
  console.log("Usage: " + process.argv[1] + " <config json>")
  process.exit(1)
}

const configuration = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
logger.info("configuration = " + JSON.stringify(configuration, null, 2))

const commandMap = new Map()
configuration.commandList.forEach(command => commandMap.set(command.httpPath, command))

const staticFileMap = new Map()
configuration.staticFileList.forEach(staticFile => staticFileMap.set(staticFile.httpPath, staticFile))

const indexHtml = `<!DOCTYPE html>
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
    ${configuration.commandList.map(command => `<li><a href="${command.httpPath}">${command.description}</a></li>`).join('')}
  </ul>
</body>
</html>
`

function serveIndex(response) {
  response.writeHead(200, {'Content-Type': 'text/html'})
  response.end(indexHtml)
}

async function serveCommand(command, response) {
  let preString
  try {
    const { stdout, stderr } = await asyncExec(command.command)
    preString = `Now: ${new Date().toISOString()}\n\n`
    preString += `$ ${command.command}\n\n`
    preString += escapeHtml(stderr + stdout)
  } catch (err) {
    preString = err
  }

  const commandHtml = `<!DOCTYPE html>
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
  `

  response.writeHead(200, {'Content-Type': 'text/html'})
  response.end(commandHtml)
}

async function serveFile(staticFile, response) {
  try {
    const data = await asyncReadFile(staticFile.filePath)
    response.writeHead(200, {
      'Content-Type': staticFile.contentType,
      'Cache-Control': 'max-age=' + staticFile.cacheMaxAgeSeconds
    })
    response.end(data)
  } catch (err) {
    logger.error('serveFile err = ' + err)
    response.writeHead(404)
    response.end()
  }
}

async function requestHandler(request, response) {
  response.on('finish', function() {
    logger.info(`${request.socket.remoteAddress}:${request.socket.remotePort} ${request.method} ${request.url} ${response.statusCode}`)
  })

  if (request.url == '/') {
    serveIndex(response)
  } else if (commandMap.has(request.url)) {
    const command = commandMap.get(request.url)
    await serveCommand(command, response)
  } else if (staticFileMap.has(request.url)) {
    const staticFile = staticFileMap.get(request.url)
    await serveFile(staticFile, response)
  } else {
    response.writeHead(404, {'Content-Type': 'text/plain'})
    response.end('Unknown path')
  }
}

function main() {
  const server = http.createServer(requestHandler)
  server.listen(configuration.port, (err) => {
    if (err) {
      logger.error('something bad happened', err)
      return
    }
    logger.info(`server is listening on ${configuration.port}`)
  })
}

main()
