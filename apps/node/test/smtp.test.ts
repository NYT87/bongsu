// MAILER = "smtp" on Node: an email reaches an SMTP server (here a tiny fake one, as Mailpit would catch it in
// docker-compose), and connection alerts go through it like any mailer.
import { createServer, type Server } from "node:net";
import { mailer, registerMailer } from "@bongsu/core/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { smtpMailer } from "../src/smtp";

let server: Server;
let port = 0;
const received: { from: string; to: string[]; data: string }[] = [];

beforeAll(async () => {
  // Just enough SMTP for one message per connection: greeting, EHLO, MAIL, RCPT, DATA, QUIT.
  server = createServer((sock) => {
    let mail = { from: "", to: [] as string[], data: "" };
    let inData = false;
    let buf = "";
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i = buf.indexOf("\r\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(mail);
            mail = { from: "", to: [], data: "" };
            sock.write("250 queued\r\n");
          } else mail.data += `${line}\n`;
        } else if (/^(EHLO|HELO)/i.test(line)) sock.write("250 fake\r\n");
        else if (/^MAIL FROM:/i.test(line)) {
          mail.from = line.slice(10).replace(/[<>]/g, "").split(" ")[0];
          sock.write("250 ok\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          mail.to.push(line.slice(8).replace(/[<>]/g, ""));
          sock.write("250 ok\r\n");
        } else if (/^DATA/i.test(line)) {
          inData = true;
          sock.write("354 go on\r\n");
        } else if (/^QUIT/i.test(line)) {
          sock.end("221 bye\r\n");
        } else sock.write("250 ok\r\n");
        i = buf.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe("the smtp mailer", () => {
  it("delivers through the relay", async () => {
    registerMailer("smtp", smtpMailer);
    const m = mailer(
      { MAILER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), MAIL_FROM: "Bongsu <bongsu@example.com>" },
      fetch,
    );
    expect(m.id).toBe("smtp");
    await m.send({ to: ["owner@example.com"], subject: "Bongsu: a connection needs attention", text: "Reconnect it." });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: "bongsu@example.com", to: ["owner@example.com"] });
    expect(received[0].data).toMatch(/Subject: Bongsu: a connection needs attention/);
    expect(received[0].data).toMatch(/Reconnect it\./);
  });

  it("says what's missing", () => {
    expect(() => smtpMailer({ MAILER: "smtp" })).toThrow(/SMTP_HOST and MAIL_FROM/);
  });
});
