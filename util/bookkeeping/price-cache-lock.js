"use strict";

/**
 * @file util/bookkeeping/price-cache-lock.js
 * @module bookkeeping/price-cache-lock
 * @description
 * One run at a time of the report that prices coins. The report keeps
 * the prices it fetches in two cache files (`./usd-prices.js`), and a run
 * writing them while another run did could drop that run's newest
 * prices. So a run takes a lock before it asks for the Moralis key or
 * prices anything: it creates a lock file beside the caches, which only
 * one process can create (`fs.openSync` with the `wx` flag fails when the
 * file is there already). The file names the process that took it, and
 * when.
 *
 * The run removes the file as it ends, whether it wrote its csv or
 * stopped on an error, and on Ctrl+C or a kill signal (SIGINT, SIGTERM,
 * SIGHUP). A run started while another holds the lock stops at once,
 * saying which run holds it. A run killed outright (`kill -9`, Node
 * itself crashing, the machine going down) can neither remove the file
 * nor print anything, so the next run, finding the file, says how to
 * release it.
 *
 * Dependency-free, so a test can take the lock in a process of its own
 * and stop that process the ways a run can be stopped.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** The lock file's name, in the folder of the caches it guards. */
const PRICE_CACHE_LOCK_FILE = "price-caches.lock";

/** The signals that stop a run; each releases the lock first. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * The process that took a lock, and when, as its file names them.
 * @param {string} lockPath
 * @returns {{pid: number, takenAt: string}|null}  Null when the file is
 *   gone, still empty, or names neither.
 */
function holderOf(lockPath) {
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
  const named =
    holder !== null &&
    typeof holder === "object" &&
    Number.isInteger(holder.pid) &&
    typeof holder.takenAt === "string";
  return named ? holder : null;
}

/**
 * The error a run stops with when another run holds the lock: which run,
 * and how to release a lock that a stopped run left.
 * @param {string} lockPath
 * @returns {Error}  With `lockHeld` set.
 */
function heldError(lockPath) {
  const holder = holderOf(lockPath);
  const named =
    holder === null ? "" : `: process ${holder.pid}, since ${holder.takenAt}`;
  const check =
    holder === null
      ? "If no run of the report is running"
      : `If \`ps -p ${holder.pid}\` lists no such process`;
  const message =
    `Another run of the report holds the cache of prices${named}. ` +
    `Run this one once it ends. ${check}, that run stopped before it ` +
    `could release the lock: delete the lock with \`rm '${lockPath}'\`, ` +
    "then run again.";
  return Object.assign(new Error(message), { lockHeld: true });
}

/**
 * Take the lock on the price caches for this run. Until the returned
 * function is called, a Ctrl+C, a kill signal or the process ending
 * releases it.
 * @param {string} lockPath  The lock file, beside the caches.
 * @returns {Function}  Releases the lock; once is enough, and a second
 *   call does nothing.
 * @throws {Error}  With `lockHeld` set, when another run holds the lock;
 *   its message says which run, and how to release a lock left behind.
 */
function takePriceCacheLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw heldError(lockPath);
    throw error;
  }
  try {
    const holder = { pid: process.pid, takenAt: new Date().toISOString() };
    fs.writeSync(fd, `${JSON.stringify(holder)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
    process.off("exit", release);
    fs.rmSync(lockPath, { force: true });
  };
  /*-
   *  A listener replaces Node's own end for the signal, so this one ends
   *  the process itself, with the status a shell gives a process the
   *  signal stopped: 128 and the signal's number.
   */
  const onSignal = (signal) => {
    release();
    process.exit(128 + os.constants.signals[signal]);
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  process.on("exit", release);
  return release;
}

module.exports = { PRICE_CACHE_LOCK_FILE, takePriceCacheLock };
