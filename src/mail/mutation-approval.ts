import { requestWindowsApprovalDetailed, type ApprovalResult } from "../approval.js";

export interface MailMutationRequest {
  action: "move" | "trash";
  account: string;
  destination: string;
  messages: readonly { mailbox: string; uidValidity: string; uid: number }[];
  expiresAt: string;
}
export interface MailMutationApproval { confirm(request: MailMutationRequest): Promise<ApprovalResult>; }
export const denyMailMutation: MailMutationApproval = { confirm: async () => ({ status: "unavailable" }) };
export class WindowsMailMutationApproval implements MailMutationApproval {
  confirm(request: MailMutationRequest): Promise<ApprovalResult> {
    return requestWindowsApprovalDetailed({
      title: "QQ Mail - Confirm mailbox change",
      description: request.action === "trash" ? "Move these messages to Trash. This is not permanent deletion." : "Move these messages to the selected mailbox.",
      confirmLabel: request.action === "trash" ? "Move to Trash" : "Move messages",
      expiresAt: request.expiresAt,
      preview: { account: request.account, destination: request.destination, count: request.messages.length, messages: request.messages },
    });
  }
}
