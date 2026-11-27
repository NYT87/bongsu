// The audit log keeps who did what by id, never a person's email (#142): an email in an audit row would outlive the
// account it belongs to. Every audit write passes its target and detail through here, so one that slips in is masked.

/** Something shaped like an email address: a local part, @, a domain with a dot. A handle like "@demo_travel" isn't. */
const EMAIL_LIKE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** The text with every email in it replaced by "[email]". */
export const noEmail = <T extends string | null>(s: T): T => (s === null ? s : s.replace(EMAIL_LIKE, "[email]")) as T;

/** An audit row's detail, as stored: JSON, with no email in it. */
export const auditDetail = (detail: unknown): string => noEmail(JSON.stringify(detail));
