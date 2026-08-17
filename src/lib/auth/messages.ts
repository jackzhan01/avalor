/**
 * Refusal wording that the UI has to recognise, not just display.
 *
 * The gate runs on the server and the sheet renders in the browser, and the
 * error crosses between them as a plain string — by the time it reaches the
 * sheet, the reason code is gone. Matching on a shared constant keeps that one
 * fragile seam in a single place instead of leaving a Chinese substring
 * hardcoded in a component, where a reworded message would silently remove
 * the login button and nothing would fail.
 *
 * Deliberately its own module: the gate imports `server-only`, so a client
 * component cannot reach the constant through it.
 */
export const NEEDS_LOGIN = "需要先登录";
