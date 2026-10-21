import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ImapFlowGateway } from "../src/mail/gateways.js";
import { IMAP_DOWNLOAD_CHUNK_BYTES, MAX_IMAP_LITERAL_BYTES } from "../src/mail/read-budget.js";

let key: Buffer;
let cert: string;
let previousCa: string[];
beforeAll(async () => {
  key = await readFile(new URL("./fixtures/synthetic-key.pem", import.meta.url));
  cert = await readFile(new URL("./fixtures/synthetic-cert.pem", import.meta.url), "utf8");
  previousCa = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...previousCa, cert]);
});
afterAll(() => tls.setDefaultCACertificates(previousCa));

async function imapFixture(mode: "chunked" | "oversized", size = 0) {
  const connections = new Set<tls.TLSSocket>();
  const stats = { windows: [] as Array<{ offset: number; length: number }>, literalPayloadBytes: 0, closed: false, announced: 0 };
  const block = Buffer.alloc(IMAP_DOWNLOAD_CHUNK_BYTES, 0x61);
  const mime = Buffer.from("Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: 8bit\r\nContent-Disposition: attachment; filename=synthetic.bin\r\n\r\n");
  const server = tls.createServer({ key, cert, minVersion: "TLSv1.2" }, socket => {
    connections.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => { connections.delete(socket); stats.closed = true; });
    socket.setEncoding("utf8");
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] synthetic ready\r\n");
    let input = "";
    let authTag: string | undefined;
    socket.on("data", data => {
      input += data;
      let end: number;
      while ((end = input.indexOf("\r\n")) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (authTag) { socket.write(`${authTag} OK synthetic authenticated\r\n`); authTag = undefined; continue; }
        const match = /^(\S+) (.+)$/u.exec(line);
        if (!match) continue;
        const tag = match[1]!;
        const command = match[2]!;
        const upper = command.toUpperCase();
        const ok = () => socket.write(`${tag} OK completed\r\n`);
        if (upper === "CAPABILITY") { socket.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n"); ok(); }
        else if (upper.startsWith("AUTHENTICATE PLAIN")) { authTag = tag; socket.write("+ \r\n"); }
        else if (upper.startsWith("LOGIN")) ok();
        else if (upper.startsWith("LIST") || upper.startsWith("LSUB")) { socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n'); ok(); }
        else if (upper.startsWith("SELECT") || upper.startsWith("EXAMINE")) {
          socket.write("* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 42] validity\r\n* OK [UIDNEXT 2] next\r\n");
          socket.write(`${tag} OK [READ-WRITE] selected\r\n`);
        } else if (upper.startsWith("UID FETCH") || upper.startsWith("FETCH")) {
          if (mode === "oversized") {
            stats.announced = MAX_IMAP_LITERAL_BYTES + 1;
            // Keep the connection open and send no literal bytes. The client
            // must reject the size marker before waiting for/materializing data.
            socket.write(`* 1 FETCH (UID 1 BODY[]<0> {${stats.announced}}\r\n`);
            continue;
          }
          socket.write(`* 1 FETCH (UID 1 RFC822.SIZE ${size + mime.length}`);
          for (const request of command.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/giu)) {
            const section = request[1]!;
            const offset = Number(request[2] ?? 0);
            const length = Number(request[3] ?? mime.length);
            const isMetadata = section.toLowerCase().endsWith(".mime");
            const bytes = isMetadata ? mime : block.subarray(0, Math.max(0, Math.min(length, size - offset)));
            if (!isMetadata) stats.windows.push({ offset, length });
            stats.literalPayloadBytes += bytes.length;
            socket.write(` BODY[${section}]${request[2] !== undefined ? `<${offset}>` : ""} {${bytes.length}}\r\n`);
            socket.write(bytes);
          }
          socket.write(")\r\n"); ok();
        } else if (upper === "LOGOUT") { socket.write("* BYE closing\r\n"); ok(); socket.end(); }
        else if (["NOOP", "CLOSE", "UNSELECT"].includes(upper)) ok();
        else socket.write(`${tag} BAD unsupported synthetic command\r\n`);
      }
    });
  });
  server.on("tlsClientError", () => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const session = await new ImapFlowGateway().connect(
    { host: "127.0.0.1", port: (server.address() as { port: number }).port, security: "tls" },
    "synthetic@example.test", "SYNTHETIC_ONLY",
  );
  await session.selectMailbox("INBOX");
  return { session, stats, block, async close() {
    await session.close();
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

describe("IMAP protocol literal budget", () => {
  it("streams a full 100 MiB attachment in 64 KiB literals despite the 32 MiB literal ceiling", async () => {
    const size = 100 * 1024 * 1024;
    const fixture = await imapFixture("chunked", size);
    try {
      const download = await fixture.session.downloadPart(1, "2", size + 1);
      let actualBytes = 0;
      const actualHash = createHash("sha256");
      for await (const chunk of download.content) {
        actualBytes += chunk.length;
        actualHash.update(chunk);
      }
      const expectedHash = createHash("sha256");
      for (let offset = 0; offset < size; offset += fixture.block.length) expectedHash.update(fixture.block);
      expect(actualBytes).toBe(size);
      expect(actualHash.digest("hex")).toBe(expectedHash.digest("hex"));
      expect(MAX_IMAP_LITERAL_BYTES).toBe(32 * 1024 * 1024);
      expect(fixture.stats.windows.length).toBeGreaterThan(size / IMAP_DOWNLOAD_CHUNK_BYTES);
      expect(fixture.stats.windows.every(window => window.length === IMAP_DOWNLOAD_CHUNK_BYTES)).toBe(true);
      expect(fixture.stats.windows.at(-1)?.offset).toBe(size);
    } finally { await fixture.close(); }
  }, 120_000);

  it("rejects an oversized announced source literal without receiving its body", async () => {
    const fixture = await imapFixture("oversized");
    try {
      await expect(fixture.session.fetchMessages([1], { sourceMaxBytes: 1024 })).rejects.toBeDefined();
      expect(fixture.stats.announced).toBe(32 * 1024 * 1024 + 1);
      expect(fixture.stats.literalPayloadBytes).toBe(0);
      await vi.waitFor(() => expect(fixture.stats.closed).toBe(true));
    } finally { await fixture.close(); }
  }, 10_000);
});
