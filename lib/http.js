/**
 * Tiny HTTP helpers for the sidebar bridge.
 *
 * Every mutating request must carry `x-context-handoff: 1`. That custom header
 * forces a CORS preflight for a cross-site page, which this host does not
 * answer, so a malicious page cannot flip the switch or start a handoff. A
 * present Origin must also match Host; an absent Origin is allowed because the
 * Desktop proxy strips it before forwarding to the in-process host.
 *
 * @module dsh-context-handoff/http
 */

/** Write a JSON response with no-store caching. */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Read a JSON body with a hard size cap.
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [maxBytes]
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(request, maxBytes = 16384) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('request body is too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('request body must be JSON')
    error.statusCode = 400
    throw error
  }
}

/**
 * Reject a mutating request that did not come from this page.
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean} true when the request may mutate state.
 */
export function mutationAllowed(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true
  if (request.method !== 'POST') return false
  if (request.headers['x-context-handoff'] !== '1') return false
  const fetchSite = request.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  const host = request.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return parsed.host === host
  } catch {
    return false
  }
}

/** Send a route error, keeping expected failures readable. */
export function sendError(response, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
  const message = error instanceof Error ? error.message : String(error)
  sendJson(response, status, { ok: false, error: message })
}
