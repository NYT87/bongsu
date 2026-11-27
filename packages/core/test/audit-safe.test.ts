import { describe, expect, it } from "vitest";
import { auditDetail, noEmail } from "../src/audit-safe";

describe("audit rows keep no email (#142)", () => {
  it("masks anything shaped like an email, in a target or a detail", () => {
    expect(noEmail("new@example.com")).toBe("[email]");
    expect(noEmail(null)).toBeNull();
    expect(auditDetail({ to: "Ada <ada@example.com>", note: "sent to ben.k+x@mail.example.co.uk." })).toBe(
      '{"to":"Ada <[email]>","note":"sent to [email]."}',
    );
  });

  it("leaves ids, handles and plain text alone", () => {
    for (const s of ["user:u_1a2b", "invite:abcdef0123456789", "@demo_travel", "@demo.bsky.social", "w_123", "a @ b"])
      expect(noEmail(s)).toBe(s);
    expect(auditDetail({ role: "editor", mailed: true })).toBe('{"role":"editor","mailed":true}');
  });
});
