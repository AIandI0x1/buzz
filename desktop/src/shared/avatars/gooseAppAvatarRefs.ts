export const GOOSE_APP_AVATAR_REF_PREFIX = "app-avatar:" as const;

const APP_AVATAR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GOOSE_COLLECTION_ID_PATTERN = /^(fuzzies|gloopies|pollies)[-_](\d+)$/;

type ParseGooseAppAvatarOptions = {
  allowFilenameFallback?: boolean;
};

function cleanAvatarCandidate(value: string): string {
  const basename = value
    .trim()
    .split(/[?#]/)[0]
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:apng|gif|heic|heif|jpeg|jpg|mp4|png|webm)$/i, "");
  return (basename ?? "").toLowerCase().replace(/_/g, "-").trim();
}

export function parseGooseAppAvatarId(
  value: string | null | undefined,
  options: ParseGooseAppAvatarOptions = {},
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const refIndex = trimmed.indexOf(GOOSE_APP_AVATAR_REF_PREFIX);
  if (refIndex >= 0) {
    const rawId = trimmed.slice(refIndex + GOOSE_APP_AVATAR_REF_PREFIX.length);
    const id = cleanAvatarCandidate(rawId);
    return APP_AVATAR_ID_PATTERN.test(id) ? id : null;
  }

  if (options.allowFilenameFallback) {
    const candidate = cleanAvatarCandidate(trimmed);
    const collectionMatch = GOOSE_COLLECTION_ID_PATTERN.exec(candidate);
    if (collectionMatch) {
      return `${collectionMatch[1]}-${collectionMatch[2]}`;
    }
  }

  return null;
}

export function toGooseAppAvatarRef(
  value: string | null | undefined,
  options: ParseGooseAppAvatarOptions = {},
): string | null {
  const id = parseGooseAppAvatarId(value, options);
  return id ? `${GOOSE_APP_AVATAR_REF_PREFIX}${id}` : null;
}

export function isGooseAppAvatarRef(value: string | null | undefined): boolean {
  return toGooseAppAvatarRef(value) !== null;
}

function isPersistableAvatarUrl(value: string): boolean {
  return /^(?:https?:|data:image\/|blob:)/i.test(value);
}

export function resolveImportedPersonaAvatarUrl({
  avatarDataUrl,
  avatarRef,
}: {
  avatarDataUrl?: string | null;
  avatarRef?: string | null;
}): string | null {
  const trimmedAvatarRef = avatarRef?.trim();
  const avatarRefFileFallback =
    trimmedAvatarRef && !isPersistableAvatarUrl(trimmedAvatarRef)
      ? toGooseAppAvatarRef(trimmedAvatarRef, { allowFilenameFallback: true })
      : null;
  const gooseRef =
    toGooseAppAvatarRef(avatarRef) ??
    avatarRefFileFallback ??
    toGooseAppAvatarRef(avatarDataUrl);
  if (gooseRef) {
    return gooseRef;
  }

  for (const candidate of [avatarRef, avatarDataUrl]) {
    const trimmedAvatarUrl = candidate?.trim();
    if (trimmedAvatarUrl && isPersistableAvatarUrl(trimmedAvatarUrl)) {
      return trimmedAvatarUrl;
    }
  }

  return null;
}
