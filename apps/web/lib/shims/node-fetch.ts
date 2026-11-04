/**
 * Browser shim for node-fetch: dcap-qvl only requires it when global fetch is
 * absent. Every supported browser has fetch, so re-export the global.
 */
export default globalThis.fetch.bind(globalThis);
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
