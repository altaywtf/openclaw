// Profile hero: live personal identity, or the agent preview for unidentified connections.
import { html, nothing } from "lit";
import type { AgentIdentityResult } from "../../api/types.ts";
import "../../components/viewer-facepile.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsGroup } from "../../components/settings-ui.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../../lib/avatar.ts";

type HeroAgentRow = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

type HeroAgentIdentity = AgentIdentityResult | null | undefined;

export type ProfileHeroProps = {
  selfUser: AuthenticatedUser | null;
  agentId: string;
  row: HeroAgentRow;
  identity: HeroAgentIdentity;
  resolveImageUrl: (avatarUrl: string) => string | null;
  failedAvatarUrl: string | null;
  onAvatarError: (avatarUrl: string) => void;
};

function renderHeroAvatar(props: ProfileHeroProps) {
  if (props.selfUser) {
    return html`<openclaw-viewer-avatar
      .user=${{ ...props.selfUser, watchedSessions: [] }}
      variant="profile"
    ></openclaw-viewer-avatar>`;
  }
  const avatarUrl = resolveAgentAvatarUrl(props.row, props.identity);
  const textAvatar =
    resolveAssistantTextAvatar(props.identity?.avatar) ??
    resolveAssistantTextAvatar(props.row.identity?.emoji) ??
    resolveAssistantTextAvatar(props.row.identity?.avatar);
  const name = heroName(props);
  const imageUrl = avatarUrl?.startsWith("/") ? props.resolveImageUrl(avatarUrl) : avatarUrl;
  if (avatarUrl && avatarUrl !== props.failedAvatarUrl && imageUrl) {
    return html`<img
      class="profile-hero__avatar-image"
      src=${imageUrl}
      alt=${name}
      @error=${() => props.onAvatarError(avatarUrl)}
    />`;
  }
  if (textAvatar) {
    return html`<span class="profile-hero__avatar-text">${textAvatar}</span>`;
  }
  return html`<span class="profile-hero__avatar-mascot" aria-hidden="true">${icons.lobster}</span>`;
}

function heroName(props: ProfileHeroProps): string {
  // Presence owns live absence too: a cached users.self name can be stale after clearing.
  if (props.selfUser) {
    return props.selfUser.name?.trim() || props.selfUser.email || props.selfUser.id;
  }
  return (
    props.identity?.name?.trim() ||
    props.row.identity?.name?.trim() ||
    props.row.name?.trim() ||
    props.agentId
  );
}

export function renderProfileHero(props: ProfileHeroProps) {
  return renderSettingsGroup(html`
    <section class="profile-hero">
      <div class="profile-hero__avatar">${renderHeroAvatar(props)}</div>
      <div class="profile-hero__name">${heroName(props)}</div>
      <div class="profile-hero__handle">
        ${
          props.selfUser
            ? props.selfUser.email
              ? html`<span class="profile-hero__email">${props.selfUser.email}</span>`
              : nothing
            : html`<span>@${props.agentId}</span>`
        }
        <span class="profile-hero__badge">OpenClaw</span>
      </div>
    </section>
  `);
}
