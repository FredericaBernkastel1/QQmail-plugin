import { readFile } from "node:fs/promises";
import tls from "node:tls";
import net from "node:net";
import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ImapFlowGateway, NodemailerSmtpGateway } from "../src/mail/gateways.js";
import type { OutgoingMessage } from "../src/mail/types.js";
import { createSettingsCallbacks } from "../src/settings/callbacks.js";
import { SettingsServer } from "../src/settings/server.js";
import { configSchema } from "../src/config.js";
import { OutgoingAttachmentStore } from "../src/outgoing-attachments.js";
import { simpleParser } from "mailparser";

// Real TLS, IMAP and SMTP. All endpoints, credentials and messages are synthetic.
const credential = "SYNTHETIC_ONLY";
const body = "Synthetic fixture body";
const source = Buffer.from(`From: synthetic@example.test\r\nTo: receiver@example.test\r\nSubject: Synthetic\r\nMessage-ID: <fixture@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
const sockets = new Set<net.Socket>();
let smtp: tls.Server;
let imap: tls.Server;
let smtpStarttls: net.Server;
let imapStarttls: net.Server;
let smtpPort = 0;
let imapPort = 0;
let smtpStarttlsPort = 0;
let imapStarttlsPort = 0;
let deliveries = 0;
let smtpConnections = 0;
let smtpAuthentications = 0;
let smtpDataMessages = 0;
type SmtpFixtureMode = "normal" | "explicitreject" | "drop-after-DATA";
let smtpMode: SmtpFixtureMode = "normal";
let sentCopies = 0;
let lastDelivered = "";
let lastAppended = "";
let oldCa: string[] = [];
const flags = new Set<string>();
const capability = "IMAP4rev1 UIDPLUS MOVE AUTH=PLAIN";
const commands: string[] = [];

beforeEach(() => { smtpMode = "normal"; });

beforeAll(async () => {
  const key = await readFile(new URL("./fixtures/synthetic-key.pem", import.meta.url));
  const cert = await readFile(new URL("./fixtures/synthetic-cert.pem", import.meta.url), "utf8");
  oldCa = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...oldCa, cert]);
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  };
  const handleSmtp = (socket: tls.TLSSocket, greeting = true) => {
    // Bind the selected fault to this connection; later test resets must not
    // alter a previous connection that is still being closed by its client.
    const mode = smtpMode;
    smtpConnections++;
    track(socket);
    socket.setEncoding("utf8");
    if (greeting) socket.write("220 synthetic.test ESMTP ready\r\n");
    let buffer = "";
    let data = false;
    let authenticated = false;
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          expect(buffer.slice(0, end)).toContain("Synthetic");
          lastDelivered = buffer.slice(0, end).replace(/^\.\./gmu, ".");
          smtpDataMessages++;
          buffer = buffer.slice(end + 5);
          data = false;
          if (mode === "explicitreject") {
            socket.write("554 5.7.1 Synthetic message rejected\r\n");
            continue;
          }
          deliveries++;
          if (mode === "drop-after-DATA") {
            // The synthetic queue accepted the complete DATA payload, but the
            // client never receives a final 250 response. A retry could duplicate it.
            socket.destroy();
            return;
          }
          socket.write("250 2.0.0 synthetic queued\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250-synthetic.test\r\n250-AUTH PLAIN\r\n250 SIZE 1048576\r\n");
        else if (verb === "AUTH") {
          authenticated = Buffer.from(line.split(" ")[2] ?? "", "base64").toString().endsWith("\0" + credential);
          if (authenticated) smtpAuthentications++;
          socket.write(authenticated ? "235 2.7.0 authenticated\r\n" : "535 bad credentials\r\n");
        } else if (verb === "MAIL" || verb === "RCPT") socket.write(authenticated ? "250 OK\r\n" : "530 authenticate\r\n");
        else if (verb === "DATA" && authenticated) { data = true; socket.write("354 send content\r\n"); }
        else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 unsupported\r\n");
      }
    });
  };
  smtp = tls.createServer({ key, cert, minVersion: "TLSv1.2" }, handleSmtp);
  const handleImap = (socket: tls.TLSSocket, greeting = true) => {
    track(socket);
    socket.setEncoding("utf8");
    if (greeting) socket.write(`* OK [CAPABILITY ${capability}] synthetic ready\r\n`);
    let buffer = "";
    let append: { tag: string; bytes: number } | undefined;
    let authTag: string | undefined;
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        if (append) {
          if (buffer.length < append.bytes + 2) return;
          lastAppended = buffer.slice(0, append.bytes);
          buffer = buffer.slice(append.bytes + 2);
          sentCopies++;
          socket.write(`${append.tag} OK [APPENDUID 42 2] appended\r\n`);
          append = undefined;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (authTag) {
          const valid = Buffer.from(line, "base64").toString().endsWith("\0" + credential);
          socket.write(`${authTag} ${valid ? "OK authenticated" : "NO bad credentials"}\r\n`);
          authTag = undefined;
          continue;
        }
        const match = /^(\S+)\s+(.+)$/u.exec(line);
        if (!match) continue;
        const [, tag, command] = match;
        const upper = command!.toUpperCase();
        commands.push(upper.startsWith("AUTH") || upper.startsWith("LOGIN") ? "AUTH [synthetic redacted]" : command!);
        const ok = () => socket.write(`${tag} OK completed\r\n`);
        if (upper === "CAPABILITY") { socket.write(`* CAPABILITY ${capability}\r\n`); ok(); }
        else if (upper.startsWith("LOGIN")) {
          socket.write(`${tag} ${command!.includes(credential) ? "OK authenticated" : "NO bad credentials"}\r\n`);
        } else if (upper.startsWith("AUTHENTICATE PLAIN")) {
          authTag = tag!;
          socket.write("+ \r\n");
        } else if (upper.startsWith("ID ")) { socket.write("* ID NIL\r\n"); ok(); }
        else if (upper.startsWith("LIST") || upper.startsWith("LSUB")) {
          const label = upper.startsWith("LSUB") ? "LSUB" : "LIST";
          for (const name of ["INBOX", "Sent", "Trash"]) socket.write(`* ${label} (\\HasNoChildren) "/" "${name}"\r\n`);
          ok();
        } else if (upper.startsWith("STATUS")) {
          const mailbox = command!.match(/^STATUS\s+("[^"]+"|\S+)/iu)![1];
          socket.write(`* STATUS ${mailbox} (MESSAGES 1 UNSEEN 1 UIDVALIDITY 42 UIDNEXT 2)\r\n`); ok();
        } else if (upper.startsWith("SELECT") || upper.startsWith("EXAMINE")) {
          socket.write("* FLAGS (\\Seen \\Flagged)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 42] uid validity\r\n* OK [UIDNEXT 2] next\r\n");
          socket.write(`${tag} OK [READ-WRITE] selected\r\n`);
        } else if (upper.startsWith("UID SEARCH")) { socket.write("* SEARCH 1\r\n"); ok(); }
        else if (upper.startsWith("UID FETCH") || upper.startsWith("FETCH")) {
          const structure = `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${body.length} 1)`;
          let data = `* 1 FETCH (UID 1 FLAGS (${[...flags].join(" ")}) INTERNALDATE "20-Oct-2026 00:00:00 +0000" RFC822.SIZE ${source.length} ENVELOPE ("20 Oct 2026 00:00:00 +0000" "Synthetic" (("Synthetic" NIL "synthetic" "example.test")) NIL NIL ((NIL NIL "receiver" "example.test")) NIL NIL NIL "<fixture@example.test>") BODYSTRUCTURE ${structure}`;
          const requested = /BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/iu.exec(command!);
          if (requested) {
            const bytes = requested[1] === "" ? source : Buffer.from(body);
            const offset = Number(requested[2] ?? 0);
            const part = bytes.subarray(offset, offset + Number(requested[3] ?? bytes.length));
            data += ` BODY[${requested[1]}]${requested[2] ? `<${offset}>` : ""} {${part.length}}\r\n${part.toString()}`;
          }
          socket.write(data + ")\r\n"); ok();
        } else if (upper.startsWith("UID STORE")) {
          if (upper.includes("+FLAGS")) flags.add("\\Seen");
          if (upper.includes("-FLAGS")) flags.delete("\\Seen");
          ok();
        } else if (upper.startsWith("UID MOVE")) socket.write(`${tag} OK [COPYUID 42 1 2] moved\r\n`);
        else if (upper.startsWith("APPEND")) {
          append = { tag: tag!, bytes: Number(/\{(\d+)\}$/u.exec(command!)?.[1]) };
          socket.write("+ ready for literal\r\n");
        } else if (upper === "LOGOUT") { socket.write("* BYE synthetic closed\r\n"); ok(); socket.end(); }
        else if (["NOOP", "CLOSE", "UNSELECT"].includes(upper)) ok();
        else socket.write(`${tag} BAD unsupported command\r\n`);
      }
    });
  };
  imap = tls.createServer({ key, cert, minVersion: "TLSv1.2" }, handleImap);
  const upgradeServer = (kind: "smtp" | "imap") => net.createServer(socket => {
    track(socket);
    socket.setEncoding("utf8");
    socket.write(kind === "smtp" ? "220 synthetic STARTTLS\r\n" : "* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] synthetic STARTTLS\r\n");
    let buffer = "";
    const onData = (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (kind === "smtp" && /^EHLO /iu.test(line)) socket.write("250-synthetic.test\r\n250 STARTTLS\r\n");
        else if (kind === "imap" && /^\S+ CAPABILITY$/iu.test(line)) socket.write(`* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n${line.split(" ")[0]} OK capability\r\n`);
        else if ((kind === "smtp" && /^STARTTLS$/iu.test(line)) || (kind === "imap" && /^\S+ STARTTLS$/iu.test(line))) {
          socket.write(kind === "smtp" ? "220 begin TLS\r\n" : `${line.split(" ")[0]} OK begin TLS\r\n`);
          socket.off("data", onData);
          const secure = new tls.TLSSocket(socket, {
            isServer: true, secureContext: tls.createSecureContext({ key, cert, minVersion: "TLSv1.2" }),
          });
          secure.on("error", () => undefined);
          secure.once("secure", () => kind === "smtp" ? handleSmtp(secure, false) : handleImap(secure, false));
          return;
        } else {
          // Any authentication before upgrading is an actual test failure.
          expect(line).not.toMatch(/AUTH|LOGIN/iu);
          socket.end(kind === "smtp" ? "500 unsupported\r\n" : `${line.split(" ")[0]} BAD unsupported\r\n`);
        }
      }
    };
    socket.on("data", onData);
  });
  smtpStarttls = upgradeServer("smtp");
  imapStarttls = upgradeServer("imap");
  for (const server of [smtp, imap, smtpStarttls, imapStarttls]) {
    server.on("tlsClientError", () => undefined);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  smtpPort = (smtp.address() as { port: number }).port;
  imapPort = (imap.address() as { port: number }).port;
  smtpStarttlsPort = (smtpStarttls.address() as { port: number }).port;
  imapStarttlsPort = (imapStarttls.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([smtp, imap, smtpStarttls, imapStarttls].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  tls.setDefaultCACertificates(oldCa);
});

describe("real synthetic TLS mail gateways", () => {
  it("requires approval across real settings HTTP, callbacks and TLS SMTP authentication", async () => {
    let allowed = false, credentialReads = 0;
    const before = { connections: smtpConnections, auth: smtpAuthentications };
    const callbacks = createSettingsCallbacks({
      accountStore: {
        snapshot: async () => ({
          config: configSchema.parse({
            version: 1, preset: "custom", email: "synthetic@example.test", username: "synthetic@example.test",
            imap: { host: "127.0.0.1", port: imapPort, security: "tls" },
            smtp: { host: "127.0.0.1", port: smtpPort, security: "tls" },
            downloadDirectory: "C:\\Synthetic",
          }),
          revision: "a".repeat(36), scope: "a".repeat(64), credentialStored: true,
          unlock: async () => { credentialReads++; return credential; },
        }),
        saveConfig: async () => "a".repeat(36),
        setCredential: async () => undefined, clearCredential: async () => undefined,
      },
      settingsApproval: { confirm: async review => {
        expect(review.details.destination).toMatchObject({ host: "127.0.0.1", port: smtpPort, security: "tls" });
        return allowed;
      } },
    });
    const server = await new SettingsServer({ callbacks, html: "<html>synthetic</html>" }).start();
    const session = server.createSession();
    const perform = async () => {
      const response = await fetch(`${server.origin}/api/test`, {
        method: "POST",
        headers: { Origin: server.origin, Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ target: "smtp", config: {
          provider: "custom", email: "synthetic@example.test", displayName: "Synthetic",
          imap: { host: "127.0.0.1", port: imapPort, security: "tls", rejectUnauthorized: true },
          smtp: { host: "127.0.0.1", port: smtpPort, security: "tls", rejectUnauthorized: true },
          folders: { inbox: "INBOX", sent: "Sent", trash: "Trash", drafts: "Drafts", spam: "Junk", archive: "Archive" },
          downloadDirectory: "D:\\Synthetic\\Downloads",
        } }),
      });
      return response.json();
    };
    try {
      expect(await perform()).toMatchObject({ ok: false });
      expect(credentialReads).toBe(0);
      expect(smtpConnections).toBe(before.connections);
      expect(smtpAuthentications).toBe(before.auth);
      allowed = true;
      expect(await perform()).toMatchObject({ ok: true });
      expect(credentialReads).toBe(1);
      expect(smtpAuthentications).toBe(before.auth + 1);
      expect(smtpConnections).toBe(before.connections + 1);
    } finally { await server.close(); }
  });
  it("upgrades SMTP before authenticating with STARTTLS", async () => {
    await new NodemailerSmtpGateway().verify(
      { host: "127.0.0.1", port: smtpStarttlsPort, security: "starttls" }, "synthetic@example.test", credential,
    );
  });

  it("upgrades IMAP before authenticating with STARTTLS", async () => {
    const session = await new ImapFlowGateway().connect(
      { host: "127.0.0.1", port: imapStarttlsPort, security: "starttls" }, "synthetic@example.test", credential,
    );
    try { expect(await session.listMailboxes({ inbox: "INBOX", sent: "Sent", trash: "Trash" })).toHaveLength(3); }
    finally { await session.close(); }
  });

  for (const kind of ["smtp", "imap"] as const) {
    it(`rejects ${kind} STARTTLS downgrade before disclosing credentials`, async () => {
      let plaintextAuth = false;
      const local = new Set<net.Socket>();
      const server = net.createServer(socket => {
        local.add(socket);
        socket.setEncoding("utf8");
        socket.write(kind === "smtp" ? "220 synthetic\r\n" : "* OK [CAPABILITY IMAP4rev1] synthetic\r\n");
        socket.on("data", chunk => {
          const line = chunk.toString().trim();
          if (/AUTH|LOGIN/iu.test(line)) plaintextAuth = true;
          if (kind === "smtp") socket.write(/^EHLO /iu.test(line) ? "250 synthetic\r\n" : "500 TLS unavailable\r\n");
          else if (/CAPABILITY/iu.test(line)) socket.write(`* CAPABILITY IMAP4rev1\r\n${line.split(" ")[0]} OK capability\r\n`);
          else socket.write(`${line.split(" ")[0]} NO TLS unavailable\r\n`);
        });
        socket.on("error", () => undefined);
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      const config = { host: "127.0.0.1", port: (server.address() as { port: number }).port, security: "starttls" as const };
      try {
        const operation = kind === "smtp"
          ? new NodemailerSmtpGateway().verify(config, "synthetic@example.test", credential)
          : new ImapFlowGateway().connect(config, "synthetic@example.test", credential);
        await expect(operation).rejects.toBeDefined();
        expect(plaintextAuth).toBe(false);
      } finally {
        for (const socket of local) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }

  it("verifies SMTP authentication and transmits a MIME message once", async () => {
    const gateway = new NodemailerSmtpGateway();
    const config = { host: "127.0.0.1", port: smtpPort, security: "tls" as const };
    await gateway.verify(config, "synthetic@example.test", credential);
    const receipt = await gateway.send(config, "synthetic@example.test", credential, {
      from: { address: "synthetic@example.test", name: "Synthetic" },
      to: [{ address: "receiver@example.test", name: "Receiver" }], cc: [],
      bcc: [{ address: "hidden@example.test", name: "" }], subject: "Synthetic TLS", text: body,
    });
    expect(receipt.accepted).toHaveLength(2);
    expect(receipt.rawMessage.toString()).not.toMatch(/^Bcc:/mi);
    expect(deliveries).toBe(1);
  });

  it("uses real IMAP list/search/read/download/flags/move/append commands", async () => {
    const session = await new ImapFlowGateway().connect({ host: "127.0.0.1", port: imapPort, security: "tls" }, "synthetic@example.test", credential);
    try {
      expect((await session.listMailboxes({ inbox: "INBOX", sent: "Sent", trash: "Trash" })).map(m => m.path)).toContain("INBOX");
      expect((await session.selectMailbox("INBOX")).uidValidity).toBe("42");
      expect(await session.search({ all: true })).toEqual([1]);
      const messages = await session.fetchMessages([1], { sourceMaxBytes: 2048 });
      expect(messages[0]?.source?.toString()).toContain(body);
      const part = await session.downloadPart(1, "1", 2048);
      const chunks = [];
      for await (const chunk of part.content) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe(body);
      await session.addFlags([1], ["\\Seen"]);
      await session.removeFlags([1], ["\\Seen"]);
      await session.moveMessages([1], "Trash");
      await session.appendMessage("Sent", source, ["\\Seen"], new Date());
      expect(sentCopies).toBe(1);
    } finally { await session.close(); }
  });

  it("transmits binary attachments over real TLS SMTP and preserves them in IMAP Sent", async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 66, 0, 1]);
    const attachments = new OutgoingAttachmentStore({ read: async () => Buffer.from(bytes) });
    const scope = "a".repeat(64);
    const entries = await attachments.importSelected(["C:\\Synthetic\\附件.bin"], scope);
    const ids = entries.map(entry => entry.attachmentId);
    const before = { deliveries, sentCopies };
    const session = await new ImapFlowGateway().connect(
      { host: "127.0.0.1", port: imapPort, security: "tls" }, "synthetic@example.test", credential,
    );
    try {
      const receipt = await new NodemailerSmtpGateway().send(
        { host: "127.0.0.1", port: smtpPort, security: "tls" }, "synthetic@example.test", credential,
        { from: { address: "synthetic@example.test", name: "" }, to: [{ address: "receiver@example.test", name: "" }],
          cc: [], bcc: [], subject: "Synthetic attachment", text: body, attachmentIds: ids },
        attachments.acquire(ids, scope),
      );
      await session.appendMessage("Sent", receipt.rawMessage, ["\\Seen"], new Date());
      for (const raw of [lastDelivered, lastAppended, receipt.rawMessage]) {
        const parsed = await simpleParser(raw);
        expect(parsed.attachments[0]!.filename).toBe("附件.bin");
        expect(parsed.attachments[0]!.content).toEqual(bytes);
      }
      expect(deliveries).toBe(before.deliveries + 1);
      expect(sentCopies).toBe(before.sentCopies + 1);
    } finally { attachments.dispose(); await session.close(); }
  });

  it("rejects an untrusted TLS certificate before sending credentials", async () => {
    tls.setDefaultCACertificates(oldCa);
    try {
      await expect(new NodemailerSmtpGateway().verify(
        { host: "127.0.0.1", port: smtpPort, security: "tls" }, "synthetic@example.test", credential,
      )).rejects.toBeDefined();
    } finally {
      const cert = await readFile(new URL("./fixtures/synthetic-cert.pem", import.meta.url), "utf8");
      tls.setDefaultCACertificates([...oldCa, cert]);
    }
  });

  const outcomeMessage = (messageId: string): OutgoingMessage => ({
    messageId,
    from: { address: "synthetic@example.test", name: "Synthetic" },
    to: [{ address: "receiver@example.test", name: "Synthetic receiver" }],
    cc: [], bcc: [], subject: "Synthetic delivery outcome", text: body,
  });

  it("classifies an actual refused TLS SMTP connection as definitely not sent", async () => {
    // Obtain an unused loopback port, then close its listener before connecting.
    const reservation = net.createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const closedPort = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const before = { connections: smtpConnections, data: smtpDataMessages, deliveries };
    await expect(new NodemailerSmtpGateway().send(
      { host: "127.0.0.1", port: closedPort, security: "tls" }, "synthetic@example.test", credential,
      outcomeMessage("<synthetic-connection-refused@example.test>"),
    )).rejects.toMatchObject({ outcome: "not_sent" });
    expect(smtpConnections).toBe(before.connections);
    expect(smtpDataMessages).toBe(before.data);
    expect(deliveries).toBe(before.deliveries);
  });

  it("classifies a real explicit 554 rejection after DATA as definitely not sent", async () => {
    smtpMode = "explicitreject";
    const before = { data: smtpDataMessages, deliveries, auth: smtpAuthentications };
    const messageId = "<synthetic-explicit-rejection@example.test>";
    await expect(new NodemailerSmtpGateway().send(
      { host: "127.0.0.1", port: smtpPort, security: "tls" }, "synthetic@example.test", credential,
      outcomeMessage(messageId),
    )).rejects.toMatchObject({ outcome: "not_sent" });
    expect(smtpAuthentications).toBe(before.auth + 1);
    expect(smtpDataMessages).toBe(before.data + 1);
    expect(deliveries).toBe(before.deliveries);
    expect((await simpleParser(lastDelivered)).messageId).toBe(messageId);
  });

  it("classifies a lost final SMTP response after the server accepts DATA as delivery unknown", async () => {
    smtpMode = "drop-after-DATA";
    const before = { connections: smtpConnections, data: smtpDataMessages, deliveries, auth: smtpAuthentications };
    const messageId = "<synthetic-lost-final-response@example.test>";
    await expect(new NodemailerSmtpGateway().send(
      { host: "127.0.0.1", port: smtpPort, security: "tls" }, "synthetic@example.test", credential,
      outcomeMessage(messageId),
    )).rejects.toMatchObject({ outcome: "delivery_unknown" });
    expect(smtpConnections).toBe(before.connections + 1);
    expect(smtpAuthentications).toBe(before.auth + 1);
    expect(smtpDataMessages).toBe(before.data + 1);
    expect(deliveries).toBe(before.deliveries + 1);
    expect((await simpleParser(lastDelivered)).messageId).toBe(messageId);
  });

  it("preserves the fixed Message-ID observed by a real SMTP server after fault modes reset", async () => {
    expect(smtpMode).toBe("normal");
    const before = { connections: smtpConnections, data: smtpDataMessages, deliveries };
    const messageId = "<synthetic-fixed-id@example.test>";
    const receipt = await new NodemailerSmtpGateway().send(
      { host: "127.0.0.1", port: smtpPort, security: "tls" }, "synthetic@example.test", credential,
      outcomeMessage(messageId),
    );
    try {
      expect(receipt.messageId).toBe(messageId);
      expect((await simpleParser(lastDelivered)).messageId).toBe(messageId);
      expect((await simpleParser(receipt.rawMessage)).messageId).toBe(messageId);
      expect(smtpConnections).toBe(before.connections + 1);
      expect(smtpDataMessages).toBe(before.data + 1);
      expect(deliveries).toBe(before.deliveries + 1);
    } finally { receipt.rawMessage.fill(0); }
  });
});
