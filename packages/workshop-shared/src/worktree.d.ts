// This file declares the type of a worktree binding -- a binding that basically provides access
// to a file tree, with git integration. An agent can create a worktree binding from a git commit,
// then use its regular file-edit tooling to read and write the files in the worktree. It can also
// access the worktree programmatically in `executeCode` tool calls, where the binding has the API
// defined below.
//
// Agents can create a worktree using the `createWorktree` tool call, similar to `createGadget`
// but takes a commit ID. The commit ID can be obtained from various gatekeeper APIs, e.g. the
// GitHub gatekeeper. Commits created on a worktree can then be pushed back to the gatekeeper.

// Everything below the following line is returned to agents via `describeBinding`.
// ---- BEGIN AGENT API ----

/**
 * A worktree binding represents a file tree based on a git commit. You can read and edit files
 * in a worktree using the same tools used to operate on gadget code, targeting the worktree
 * binding instead of a gadget binding. You should prefer those tools when they work. Only use this
 * API when you want to operate on the files more programmatically, or to perform operations other
 * than basic reads and edits.
 */
interface Worktree {
  // ---------------------------------------------------------------------------
  // File operations

  // TODO(now): Add programmatic file read/write operations. Should probably be text-oriented
  //   rather than byte-oriented, I think, though maybe we'd add byte-oriented later as an option.

  /**
   * Search the given file (or recursively search the given directory) for all lines matching the
   * given regular expression.
   *
   * Returns results in the format `grep -n` would return, i.e. a string where each line is
   * "<line number>:<line content>", or if `path` refers to a directory,
   * "<file path>:<line number>:<line content>". This format is useful if you just intend to
   * console.log() it. If you intend to operate on the result programmatically, consider using
   * `structuredGrep()` instead.
   */
  grep(path: string, pattern: RegExp): Promise<string>;

  /** Like grep but returns a structured format useful for analyzing in code. */
  structuredGrep(path: string, pattern: RegExp): Promise<GrepMatch[]>;

  // ---------------------------------------------------------------------------
  // Git operations

  /**
   * Commit the contents of the worktree to git, returning the new commit ID, and updating the head
   * commit to point at it.
   *
   * There is no separate staging. All changes you have made in this worktree will be included in
   * the git commit.
   */
  commit(description: string): Promise<string>;

  /**
   * Diff the worktree content against the given commit (defaults to the current head commit).
   *
   * Returns the diff in a format similar to `git diff`.
   */
  diff(commitId?: string): Promise<string>;

  // TODO(someday):
  // - merge?
  // - soft reset? (hard reset is better-accomplished by creating a new worktree)
}

type GrepMatch = {
  /** Full path of the file containing a match. */
  file: string;

  /** Text line number (1 based) of the match. */
  line: number;

  /** Contents of the line that matched. */
  text: string;
}
