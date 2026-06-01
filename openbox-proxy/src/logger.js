/**
 * Trivial leveled logger for the proxy. Keeping it inline avoids a
 * dependency on pino/winston in a single-file sidecar.
 */

'use strict';

const debug = process.env.OPENBOX_PROXY_DEBUG === 'true';

function fmt(level, args) {
  return [`[openbox-proxy][${level}]`, ...args];
}

const log = {
  info: (...args) => console.log(...fmt('info', args)),
  warn: (...args) => console.warn(...fmt('warn', args)),
  error: (...args) => console.error(...fmt('error', args)),
  debug: (...args) => {
    if (debug) console.log(...fmt('debug', args));
  },
};

module.exports = { log };
