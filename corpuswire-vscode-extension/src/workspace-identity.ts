export interface WorkspaceIdentitySource {
  scheme: string;
  name: string;
  uri: string;
}

/** Derive a stable local identity when a workspace does not configure one. */
export function deriveDefaultWorkspaceId(source: WorkspaceIdentitySource | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  if (source.scheme !== "file") {
    return source.uri || undefined;
  }

  const slug = source.name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `local-docker://${slug}#main` : source.uri || undefined;
}
