/** Transport-neutral, sanitized domain error. Never include secrets or raw server replies. */
export class ToolFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ToolFailure"; }
}

export class DeliveryFailure extends Error {
  constructor(readonly outcome: "not_sent" | "delivery_unknown") {
    super(outcome === "not_sent" ? "SMTP did not accept this message." : "SMTP acceptance could not be determined.");
    this.name = "DeliveryFailure";
  }
}
