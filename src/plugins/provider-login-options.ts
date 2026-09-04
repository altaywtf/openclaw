import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { compareProviderAuthChoiceGroups } from "./provider-auth-choice-order.js";
import {
  resolveManifestDeclaredProviderAuthChoices,
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";

export type ProviderLoginOption = {
  id: string;
  brandId?: string;
  label: string;
  hint?: string;
  groupLabel?: string;
  icon?: string;
  website?: string;
  kind: "oauth" | "device-code" | "secret";
  featured: boolean;
};

export type ProviderAccessOption = Omit<ProviderLoginOption, "kind"> & {
  actionLabel?: string;
  kind: ProviderLoginOption["kind"] | "setup";
  mode: "login" | "setup";
};

export type ProviderChannelLoginChoice = {
  choiceId: string;
  pluginId: string;
  providerId: string;
  methodId: string;
  label: string;
  providerLabel: string;
  command: string;
  mode: "chat" | "secret" | "setup" | "sign-in";
};

export type ProviderOAuthLoginGroup = {
  pluginId: string;
  providerId: string;
  label: string;
};

export type ProviderChannelLoginResolution =
  | { status: "resolved"; choice: ProviderChannelLoginChoice }
  | { status: "providers"; providers: ProviderOAuthLoginGroup[] }
  | {
      status: "ambiguous" | "unsupported";
      choices: ProviderChannelLoginChoice[];
    };

export function supportsProviderAuthChoiceTextInference(
  scopes?: ProviderAuthChoiceMetadata["onboardingScopes"],
): boolean {
  return !scopes || scopes.includes("text-inference");
}

function isProviderLoginSurfaceEligible(choice: ProviderAuthChoiceMetadata): boolean {
  return (
    choice.choiceId.trim().length > 0 &&
    supportsProviderAuthChoiceTextInference(choice.onboardingScopes) &&
    choice.assistantVisibility !== "manual-only"
  );
}

function projectSharedOptionFields(choice: ProviderAuthChoiceMetadata) {
  return {
    id: choice.choiceId.trim(),
    brandId: choice.providerId,
    label: choice.choiceLabel,
    ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
    ...(choice.icon ? { icon: choice.icon } : {}),
    ...(choice.website ? { website: choice.website } : {}),
    featured: choice.onboardingFeatured === true,
  };
}

function toProviderLoginOption(
  choice: ProviderAuthChoiceMetadata,
): ProviderLoginOption | undefined {
  const kind =
    choice.appGuidedAuth ??
    (choice.appGuidedSecret === true && choice.appGuidedDiscovery !== true ? "secret" : undefined);
  return isProviderLoginSurfaceEligible(choice) && kind
    ? { ...projectSharedOptionFields(choice), kind }
    : undefined;
}

function toProviderAccessOption(
  choice: ProviderAuthChoiceMetadata,
): ProviderAccessOption | undefined {
  if (!isProviderLoginSurfaceEligible(choice)) {
    return undefined;
  }
  const login = toProviderLoginOption(choice);
  return login
    ? { ...login, mode: "login" }
    : {
        ...projectSharedOptionFields(choice),
        ...(choice.appGuidedActionLabel?.trim()
          ? { actionLabel: choice.appGuidedActionLabel.trim() }
          : {}),
        kind: "setup",
        mode: "setup",
      };
}

/** Whether the Gateway can start this choice as a credential-only provider login. */
export function isProviderLoginChoiceStartable(choice: ProviderAuthChoiceMetadata): boolean {
  return toProviderLoginOption(choice) !== undefined;
}

/** Featured first, then provider family, manifest assistant priority, label, id. */
function compareProviderLoginSurface(
  a: ProviderAuthChoiceMetadata,
  b: ProviderAuthChoiceMetadata,
): number {
  return (
    Number(b.onboardingFeatured === true) - Number(a.onboardingFeatured === true) ||
    compareProviderAuthChoiceGroups(
      { id: a.groupId ?? a.providerId, label: a.groupLabel ?? a.choiceLabel },
      { id: b.groupId ?? b.providerId, label: b.groupLabel ?? b.choiceLabel },
    ) ||
    (a.assistantPriority ?? 0) - (b.assistantPriority ?? 0) ||
    a.choiceLabel.localeCompare(b.choiceLabel, "en") ||
    a.choiceId.trim().localeCompare(b.choiceId.trim(), "en")
  );
}

/**
 * Choice ids claimed by more than one owner are dropped entirely: a click on an
 * ambiguous id could otherwise start the wrong plugin's credential flow.
 */
function listRankedOptions<T>(
  authChoices: readonly ProviderAuthChoiceMetadata[],
  project: (choice: ProviderAuthChoiceMetadata) => T | undefined,
): T[] {
  const choiceIdCounts = new Map<string, number>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (id) {
      choiceIdCounts.set(id, (choiceIdCounts.get(id) ?? 0) + 1);
    }
  }
  return authChoices
    .filter((choice) => choiceIdCounts.get(choice.choiceId.trim()) === 1)
    .toSorted(compareProviderLoginSurface)
    .flatMap((choice) => {
      const option = project(choice);
      return option ? [option] : [];
    });
}

export function listProviderLoginOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): ProviderLoginOption[] {
  return listRankedOptions(authChoices, toProviderLoginOption);
}

export function listProviderAccessOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): ProviderAccessOption[] {
  return listRankedOptions(authChoices, toProviderAccessOption);
}

function normalizeLoginInput(value: string | undefined): string {
  return normalizeLowercaseStringOrEmpty(value ?? "").replace(/_/gu, "-");
}

export function formatProviderLoginChoiceRef(
  choice: Pick<ProviderChannelLoginChoice, "pluginId" | "choiceId">,
): string {
  return `${encodeURIComponent(choice.pluginId)}/${encodeURIComponent(choice.choiceId)}`;
}

export function formatProviderOAuthLoginRef(
  provider: Pick<ProviderOAuthLoginGroup, "pluginId" | "providerId">,
): string {
  return `oauth/${encodeURIComponent(provider.pluginId)}/${encodeURIComponent(provider.providerId)}`;
}

function channelLoginChoiceKey(
  choice: Pick<ProviderChannelLoginChoice, "pluginId" | "choiceId" | "providerId" | "methodId">,
): string {
  return `${choice.pluginId}\0${choice.choiceId}\0${choice.providerId}\0${choice.methodId}`;
}

function uniqueChoices(choices: readonly ProviderChannelLoginChoice[]) {
  return [...new Map(choices.map((choice) => [channelLoginChoiceKey(choice), choice])).values()];
}

function compareChannelLoginChoices(
  a: ProviderChannelLoginChoice,
  b: ProviderChannelLoginChoice,
): number {
  return a.label.localeCompare(b.label, "en") || a.choiceId.localeCompare(b.choiceId);
}

function readProviderChannelLoginMetadata(
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderAuthChoiceMetadata[] {
  const choices = resolveManifestDeclaredProviderAuthChoices({
    ...params,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  });
  return choices.filter(isProviderLoginSurfaceEligible);
}

function projectProviderChannelLoginChoices(
  metadata: readonly ProviderAuthChoiceMetadata[],
): ProviderChannelLoginChoice[] {
  const providerCounts = new Map<string, number>();
  const directProviderCounts = new Map<string, number>();
  for (const choice of metadata) {
    const provider = normalizeLoginInput(choice.providerId);
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    if (choice.channelLogin) {
      directProviderCounts.set(provider, (directProviderCounts.get(provider) ?? 0) + 1);
    }
  }
  return metadata
    .map((choice): ProviderChannelLoginChoice => {
      const firstAlias = choice.channelLogin?.aliases?.[0];
      const provider = normalizeLoginInput(choice.providerId);
      const login = toProviderLoginOption(choice);
      return {
        choiceId: choice.choiceId,
        pluginId: choice.pluginId,
        providerId: choice.providerId,
        methodId: choice.methodId,
        label: choice.choiceLabel,
        providerLabel: choice.groupLabel?.trim() || choice.choiceLabel,
        command:
          firstAlias ??
          ((choice.channelLogin && (directProviderCounts.get(provider) ?? 0) === 1) ||
          (providerCounts.get(provider) ?? 0) === 1
            ? choice.providerId
            : choice.choiceId),
        mode: choice.channelLogin
          ? "chat"
          : login?.kind === "secret"
            ? "secret"
            : login
              ? "sign-in"
              : "setup",
      };
    })
    .toSorted(compareChannelLoginChoices);
}

export function listProviderChannelLoginChoices(
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderChannelLoginChoice[] {
  return projectProviderChannelLoginChoices(readProviderChannelLoginMetadata(params));
}

export function resolveProviderChannelLoginChoice(
  input: string | undefined,
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderChannelLoginResolution {
  const metadata = readProviderChannelLoginMetadata(params);
  const choices = projectProviderChannelLoginChoices(metadata);
  const projectedByOwner = new Map(
    choices.map((choice) => [channelLoginChoiceKey(choice), choice]),
  );
  const normalized = normalizeLoginInput(input);
  const select = (matches: readonly ProviderAuthChoiceMetadata[]) => {
    const resolved = uniqueChoices(
      matches.flatMap((choice) => {
        const projected = projectedByOwner.get(channelLoginChoiceKey(choice));
        return projected ? [projected] : [];
      }),
    ).toSorted(compareChannelLoginChoices);
    return resolved.length === 1
      ? ({ status: "resolved", choice: resolved[0]! } as const)
      : ({ status: "ambiguous", choices: resolved.length > 0 ? resolved : choices } as const);
  };
  if (!normalized) {
    const providers = new Map<string, ProviderOAuthLoginGroup>();
    for (const choice of metadata) {
      if (!choice.appGuidedAuth) {
        continue;
      }
      const ref = formatProviderOAuthLoginRef(choice);
      if (!providers.has(ref)) {
        providers.set(ref, {
          pluginId: choice.pluginId,
          providerId: choice.providerId,
          label: choice.groupLabel?.trim() || choice.choiceLabel,
        });
      }
    }
    return {
      status: "providers",
      providers: [...providers.values()].toSorted(
        (left, right) =>
          left.label.localeCompare(right.label, "en") ||
          formatProviderOAuthLoginRef(left).localeCompare(formatProviderOAuthLoginRef(right)),
      ),
    };
  }
  if (normalized.startsWith("oauth/") && normalized.split("/").length === 3) {
    const matches = metadata.filter(
      (choice) =>
        choice.appGuidedAuth &&
        normalizeLoginInput(formatProviderOAuthLoginRef(choice)) === normalized,
    );
    const direct = matches.filter((choice) => choice.channelLogin);
    return matches.length > 0
      ? select(direct.length > 0 ? direct : matches)
      : { status: "unsupported", choices };
  }
  const qualifiedChoices = metadata.filter(
    (choice) => normalizeLoginInput(formatProviderLoginChoiceRef(choice)) === normalized,
  );
  // A stale qualified choice must not fall through to another plugin's alias.
  if (normalized.includes("/")) {
    return qualifiedChoices.length > 0
      ? select(qualifiedChoices)
      : { status: "unsupported", choices };
  }
  const groupChoices = metadata.filter(
    (choice) => normalizeLoginInput(choice.groupId) === normalized,
  );
  const exactChoices = metadata.filter(
    (choice) => normalizeLoginInput(choice.choiceId) === normalized,
  );
  if (
    exactChoices.length > 0 &&
    (groupChoices.length <= 1 ||
      exactChoices.some(
        (choice) => choice.channelLogin !== undefined || isProviderLoginChoiceStartable(choice),
      ))
  ) {
    return select(exactChoices);
  }
  const providerOrGroup = metadata.filter(
    (choice) =>
      normalizeLoginInput(choice.providerId) === normalized ||
      normalizeLoginInput(choice.groupId) === normalized,
  );
  if (providerOrGroup.length > 0) {
    const direct = providerOrGroup.filter((choice) => choice.channelLogin);
    return select(direct.length > 0 ? direct : providerOrGroup);
  }
  const aliases = metadata.filter((choice) =>
    choice.channelLogin?.aliases?.some((alias) => normalizeLoginInput(alias) === normalized),
  );
  return aliases.length > 0 ? select(aliases) : { status: "unsupported", choices };
}
