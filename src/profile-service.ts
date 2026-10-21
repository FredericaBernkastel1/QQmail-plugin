import { AccountStateError, type AccountProfileRepository } from "./account-store.js";
import { ToolFailure } from "./errors.js";
import type { SettingsApproval } from "./settings/approval.js";

/** MCP exposes saved profile selection only. Creating profiles and entering
 * credentials remain in the separately confirmed settings interface. */
export function createAccountProfileServices(options: {
  accounts: AccountProfileRepository;
  approval: SettingsApproval;
}) {
  let switching = false;
  return {
    async listAccounts() {
      const value = await options.accounts.listProfiles();
      return { activeProfileId: value.activeProfileId, profiles: value.profiles };
    },
    async switchAccount(input: { profileId: string }) {
      if (!/^profile_[a-f0-9]{32}$/u.test(input.profileId)) throw new ToolFailure("INVALID_PROFILE", "Choose a profile ID returned by list_accounts.");
      if (switching) throw new ToolFailure("ACCOUNT_SWITCH_BUSY", "Another account switch is awaiting confirmation.");
      switching = true;
      try {
        const state = await options.accounts.listProfiles();
        const profile = state.profiles.find(entry => entry.id === input.profileId);
        if (!profile) throw new ToolFailure("PROFILE_NOT_FOUND", "The saved account profile no longer exists.");
        if (state.activeProfileId === profile.id) return { switched: false, activeProfileId: profile.id };
        const approved = await options.approval.confirm({ action: "switch-profile", details: {
          profile: structuredClone(profile),
          effect: "Activate this saved account with its own saved credential. Existing mail references, attachment references and prepared drafts expire.",
        } }).catch(() => false);
        if (!approved) throw new ToolFailure("ACCOUNT_APPROVAL_REQUIRED", "The account switch was not approved in the local confirmation window.");
        await options.accounts.switchProfile(profile.id, state.revision);
        return { switched: true, activeProfileId: profile.id };
      } catch (error) {
        if (error instanceof ToolFailure) throw error;
        if (error instanceof AccountStateError) throw new ToolFailure(error.code, error.message);
        throw new ToolFailure("ACCOUNT_SWITCH_FAILED", "The account could not be switched. Reload the saved profiles and retry.");
      } finally { switching = false; }
    },
  };
}
