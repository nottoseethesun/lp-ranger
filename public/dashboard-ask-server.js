/**
 * @file dashboard-ask-server.js
 * @description Asking the server a question at startup until it answers.
 *
 *   Startup asks the server for what the page cannot be built without,
 *   the active chain and the dashboard settings, and for what its help
 *   quotes, the figures in force. All three are asked the same way. A request has `askEveryMs` to answer;
 *   when it ends without a usable answer, the same request goes again,
 *   no sooner than `askEveryMs` after the last began, so a server that
 *   refuses at once is not asked in a tight loop. Each request that ends
 *   without an answer is logged, naming why, and reported to the caller,
 *   and the answer is returned once it comes.
 */

/**
 * Ask once.
 * @param {Function} fetchFn  The fetch to ask with.
 * @param {string} url        What to ask.
 * @param {number} limitMs    How long the server has to answer.
 * @param {(body: *) => string|null} refusal  Why a body is not an
 *   answer, or null when it is one.
 * @returns {Promise<{body: *}|{body: null, why: string}>}
 */
async function _askOnce(fetchFn, url, limitMs, refusal) {
  const signal = AbortSignal.timeout(limitMs);
  try {
    const res = await fetchFn(url, { signal });
    if (!res.ok) return { body: null, why: `it answered HTTP ${res.status}` };
    const body = await res.json();
    const why = refusal(body);
    return why === null ? { body } : { body: null, why };
  } catch (err) {
    if (err?.name === "TimeoutError")
      return { body: null, why: `no answer within ${limitMs / 1000} s` };
    return { body: null, why: `it could not be reached (${err?.message})` };
  }
}

/**
 * Ask until the server answers.
 *
 * @param {object} q
 * @param {string} q.url        What to ask.
 * @param {(body: *) => string|null} q.refusal  Why a body is not an
 *   answer, or null when it is one.
 * @param {string} q.logTag     The log line's tag, such as `[chain]`.
 * @param {string} q.asked      What was asked, as the log line says it.
 * @param {Function} q.onUnanswered  Called once for each request that
 *   ends without an answer.
 * @param {Function} q.onAnswered    Called once, when one answers.
 * @param {Function} q.fetchFn  The fetch to ask with.
 * @param {number} q.askEveryMs  How long each request has to answer, and
 *   the least time between two.
 * @param {Function} q.warnFn   Where an unanswered request is logged.
 * @returns {Promise<*>} The answer's body.
 */
export async function askUntilAnswered({
  url,
  refusal,
  logTag,
  asked,
  onUnanswered,
  onAnswered,
  fetchFn,
  askEveryMs,
  warnFn,
}) {
  for (let attempt = 1; ; attempt++) {
    const askedAt = Date.now();
    const { body, why } = await _askOnce(fetchFn, url, askEveryMs, refusal);
    if (body !== null) {
      onAnswered();
      return body;
    }
    onUnanswered();
    warnFn("%s attempt %d: %s; %s — asking again", logTag, attempt, asked, why);
    const restMs = askEveryMs - (Date.now() - askedAt);
    if (restMs > 0) await new Promise((resolve) => setTimeout(resolve, restMs));
  }
}
