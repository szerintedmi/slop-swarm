// The wake note's summary of the others' forge activity since the agent's last wake: who pushed where, opened or
// merged which pull requests, opened which issues. Built from Forgejo's per-user activity feeds (ForgeClient.activity);
// only seeds with the `{activity}` placeholder get it (run.ts fillSeed).
import type { ForgeActivity } from "../forge.ts";

/** Longest title quoted in a line, and the most items listed for one user before "…". */
const TITLE_MAX = 60;
const ITEMS_MAX = 8;

const title = (t: string) => JSON.stringify(t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t);

/** One line per user with activity, e.g. `@thistle: 3 commits to thistle/murmuration; opened PR bramble/murmur#2 "Merge"`. */
export function activityLines(byUser: Record<string, ForgeActivity[]>): string[] {
  const out: string[] = [];
  for (const [user, acts] of Object.entries(byUser)) {
    const items: string[] = [];
    const commits = new Map<string, number>();
    const comments = new Map<string, number>();
    // Feeds are newest first; read them oldest first so a created repo comes before its commits.
    for (const a of [...acts].sort((x, y) => x.at - y.at)) {
      const ref = a.index ? `${a.repo}#${a.index}` : a.repo;
      switch (a.op) {
        case "create_repo":
          items.push(a.forkOf ? `forked ${a.forkOf} to ${a.repo}` : `created ${a.repo}`);
          break;
        case "commit_repo":
          if (a.commits) commits.set(a.repo, (commits.get(a.repo) ?? 0) + a.commits);
          break;
        case "create_pull_request":
          items.push(`opened PR ${ref} ${title(a.title ?? "")}`);
          break;
        case "merge_pull_request":
          items.push(`merged PR ${ref} ${title(a.title ?? "")}`);
          break;
        case "close_pull_request":
          items.push(`closed PR ${ref} unmerged`);
          break;
        case "create_issue":
          items.push(`opened issue ${ref} ${title(a.title ?? "")}`);
          break;
        case "close_issue":
          items.push(`closed issue ${ref}`);
          break;
        case "comment_issue":
        case "comment_pull":
          comments.set(ref, (comments.get(ref) ?? 0) + 1);
          break;
      }
    }
    for (const [repo, n] of commits) items.push(`${n} commit${n === 1 ? "" : "s"} to ${repo}`);
    for (const [ref, n] of comments) items.push(`${n === 1 ? "commented" : `${n} comments`} on ${ref}`);
    if (!items.length) continue;
    const shown = items.length > ITEMS_MAX ? [...items.slice(0, ITEMS_MAX), "…"] : items;
    out.push(`@${user}: ${shown.join("; ")}`);
  }
  return out;
}
