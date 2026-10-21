import type { MailServerConfig } from "./types.js";
export function assertSecureServerConfig(config: MailServerConfig): void {
  if (config.security !== "tls" && config.security !== "starttls") throw new Error("Only TLS and STARTTLS are supported");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) throw new Error("Mail server port is invalid");
  if (!config.host || config.host.length > 253 || config.host === "localhost" || /[\s\/:?#@\[\]\\\0]/u.test(config.host)) {
    throw new Error("Mail server hostname is invalid");
  }
}
