"use strict";

/**
 * @file test/helpers/free-port.js
 * @description A port free on this machine now, for a test that starts
 *   the server or a child process listening. The system picks it, so no
 *   other program holds it: a fixed port, however high, can be taken,
 *   since the system hands out ports in the same range for outgoing
 *   connections, and the test would then fail with nothing wrong in the
 *   code.
 */

const net = require("net");

/**
 * A port free on this machine now: the system picks one, and it is let go
 * at once for the server under test to take.
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
