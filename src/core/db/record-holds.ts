// Record holds (record_holds, src/core/schema.sql): a hold stops a page being
// purged, from trash or by retention. A hold counts while it is unreleased and
// not past its keep_until date; an expired hold needs no release, so holds
// placed for a retention period cost nothing when the period ends.

/** SQL condition (on record_holds columns) for a hold that still counts. */
export const ACTIVE_HOLD = "released_at IS NULL AND (keep_until IS NULL OR keep_until >= date('now'))";

/** An unreleased hold past its date: closed (released_at = the day after keep_until) before another hold on the page is placed. */
export const CLOSE_EXPIRED_HOLD = "UPDATE record_holds SET released_at = date(keep_until, '+1 day') WHERE page_uuid = ? AND released_at IS NULL AND keep_until IS NOT NULL AND keep_until < date('now')";

export const KEEP_UNTIL = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
