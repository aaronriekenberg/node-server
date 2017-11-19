#!/usr/bin/env node

const child_process = require('child_process')
const http = require('http')
const util = require('util')
const winston = require('winston')
const asyncExec = util.promisify(child_process.exec)

const port = 8080

const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      timestamp: function() {
        return new Date().toISOString()
      },
      formatter: function(options) {
        // - Return string will be passed to logger.
        // - Optionally, use options.colorize(options.level, <string>) to
        //   colorize output based on the log level.
        return options.timestamp() + ' ' +
          winston.config.colorize(options.level, options.level.toUpperCase()) + ' ' +
          (options.message ? options.message : '') +
          (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '')
      }
    })
  ]
});

async function runCommand() {
  const { stdout, stderr } = await asyncExec('ls -l')
  return stderr + stdout
}

async function requestHandler(request, response) {
  logger.info('request = ' + request.url)
  if (request.url == '/') {
    commandOutput = await runCommand() 
    logger.info('commandOutput = ' + commandOutput)
    response.writeHead(200, {'Content-Type': 'text/plain'})
    response.end('Hello Node.js Server!')
  } else {
    response.writeHead(404, {'Content-Type': 'text/plain'})
    response.end('Unknown path')
  }
}

function main() {
  const server = http.createServer(requestHandler)
  server.listen(port, (err) => {
    if (err) {
      logger.error('something bad happened', err)
      return
    }
    logger.info(`server is listening on ${port}`)
  })
}

main()
