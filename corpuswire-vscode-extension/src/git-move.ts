// Git files that change when the working tree moves in bulk: HEAD on checkout/switch,
// ORIG_HEAD on reset, merge, pull and rebase. Per-file watcher events are unreliable
// for those, so a change here triggers one reconciliation of the whole root.
export const GIT_MOVE_GLOB = "**/.git/{HEAD,ORIG_HEAD}";

const GIT_MOVE_PATHS = new Set([".git/HEAD", ".git/ORIG_HEAD"]);

export function isGitMovePath(relativePath: string): boolean {
  return GIT_MOVE_PATHS.has(relativePath.replaceAll("\\", "/"));
}
