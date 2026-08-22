/* backend/types/express-session.d.ts
 *
 * Description of responsibility:
 *   Augments express-session's SessionData with the two fields this app
 *   actually stores in it (login, userId) — without this, every
 *   `req.session.login` access elsewhere in the backend fails to
 *   typecheck against express-session's own (empty) default shape.
 *
 * Ported unchanged (in spirit) from rotorflight-docEditor's
 * backend/types/express-session.d.ts.
 */
import "express-session";

declare module "express-session" {
  interface SessionData {
    login?: string;
    userId?: number;
  }
}
