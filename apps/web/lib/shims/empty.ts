/**
 * Browser shim for node:crypto. @phala/dcap-qvl's crypto-compat module calls
 * require('crypto') but only uses it when NOT running in a browser (its
 * isBrowser flag wins first); client bundles therefore only need the import
 * to resolve. Server-side code never reaches this shim (dcap-qvl is imported
 * dynamically from the client component only).
 */
export default {};
export const X509Certificate = undefined;
export const createHash = undefined;
export const createVerify = undefined;
export const createPublicKey = undefined;
export const createSign = undefined;
