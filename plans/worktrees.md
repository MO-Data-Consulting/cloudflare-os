# Plan: Worktrees — git-backed file workpieces pulled through gatekeepers

## Goal

Let agents naturally operate on files pulled from remote git repositories, through
gatekeepers. A **worktree** is a new kind of workpiece/binding — like a gadget
workpiece containing only code, with no ability to execute it as a gadget. An agent
creates a worktree from a git commit id (obtained from a gatekeeper API, e.g. GitHub),
reads and edits the files with its regular file tools, creates commits, and passes the
resulting commit ids back into the gatekeeper (e.g. to push a branch or open a PR).

Supporting cast:

- A **git cache** layer over the workspace's existing git object store, with
  **provenance tracking** (which gatekeeper each object can be pulled from) and lazy
  **pull-on-fault** plumbing (`Gatekeeper.gitPull()`).
- **GitHub gatekeeper git operations**: enumerate branches/tags, look up commits
  (including truncated ids), enumerate commit histories and PR commits, push commits
  to a branch, create PRs from pushed commits — every commit-returning observation
  populating `ObservationDescription.gitCommits`.

The starting point is the sketch in commit 2500f71, encpassing changes in
`workshop-shared/src/gatekeeper.ts` (`GitOid`/`GitObjectType`/`GitCache`/
`GitPullHints`, `Gatekeeper.gitPull?()`, `ObservationAuthorizer.getGitCache()`,
`ObservationDescription.gitCommits?`) and `workshop-shared/src/worktree.d.ts` (the
agent-facing `Worktree` binding API).

## Locked decisions

- **Chat-scoped.** A worktree belongs to the chat that created it and is deleted with
  the chat. Fresh agents create their own worktrees. Nothing structural forbids
  workspace-scoped worktrees later (worktrees get ordinary `WorkpieceId`s from the
  shared counter), but no cross-chat visibility ships now.
- **No UI.** Worktrees do not appear in the workshop UI at all. `subscribeToWorkpieces`
  reads only the `gadgets` collection, so this is free — a future change can add a
  `WorkpieceSummary` variant when the UI is ready for large repos.
- **Edits ride the existing chat OT stream.** `CodeChange` is already keyed by
  `WorkpieceId` and pins are `{gadgetId, baseCommit}`; a worktree is *born pinned* at
  its base commit, so readFile/writeFile/editFile, the read-before-edit gate,
  `chatChanges` rows, replay, and compaction all work unchanged. (The alternative — a
  worktree-local overlay — was rejected: agent replay needs content-at-each-point
  history, which is most of the OT stream rebuilt.)
- **Epoch resets auto-commit dirty worktrees, and auto-commits are squashed away.**
  `mergeChanges`' epoch reset evaporates all pins, so accept writes a local
  **auto-commit** per dirty worktree and re-pins at it in the new generation — content
  is never lost. But the worktree API never reveals auto-commits: reported HEAD is the
  last *explicit* commit, and a new explicit `commit()` parents on the last explicit
  commit (auto-commits become dangling objects; there is no GC, and dangling loose
  objects are cheap).
- **Transport: custom smart-HTTP fetch client, not isomorphic-git's high-level fetch.**
  Protocol v2, pkt-line composed by hand, `want`s by SHA, one-shot `have`s followed by
  an immediate `done` (no multi-round negotiation — isomorphic-git does no better).
  Reuse isomorphic-git's packfile parsing (delta resolution) where its internals allow.
  Packfiles are unpacked wholesale into the `GitCache` and never stored or indexed
  long-term: eviction + re-fetch replaces pack-based history storage. The gatekeeper
  remembers tips it has fetched before to build the `have` list, but correctness never
  depends on `have`s — all our pulls are shallow, so an empty `have` list merely
  over-fetches a little. Git sync is generally simplified by the assumption that
  intermediate changes were not synced through some path the gatekeeper didn't see.
- **Push is native send-pack, not REST git-data — required, not preferred.** REST
  git-data re-creates objects server-side from JSON; any serialization difference
  yields a different SHA than the commit id the agent holds, silently breaking the
  "push the commit I made" contract. Sending our exact bytes in a pack guarantees oid
  fidelity.
- **Trees eager; blobs eager under a modest size limit.** Worktree creation pulls the
  commit, its full tree structure, and all blobs under `EAGER_BLOB_LIMIT` in one fetch
  (`filter blob:limit=…`). Larger blobs fault in on first access (GitHub is slow;
  over-laziness costs agent latency, so only genuinely large files pay it). Files over
  `MAX_WORKTREE_FILE_SIZE` (~1MB, aligned with the existing `MAX_FILE_TEXT_LENGTH` /
  2MB-record constraints) are unsupported for now: reads error cleanly, grep skips
  them. Batch operations (grep over a directory) fill **all** missing blobs in a
  single fetch — never a serial walk-and-fetch.
- **Text only, like the rest of git-store.** Binary files are not editable; treat
  binary blobs like oversized ones (clean error on read, skipped by grep). Blob bytes
  still land in the cache unmodified, so push round-trips binaries that came from a
  pull untouched.
- **No eviction yet.** The `GitCache` contract *permits* eviction (that's why
  provenance exists — evicted objects are re-pullable), but v1 implements none.
  Provenance rows are the future re-pull index; gadget-history objects remain rooted
  by records/pins as documented in git-store.ts.

## Current-state anchors (for orientation)

- Object store: `git-store.ts` — SHA-1 zlib loose objects in the `gitObjects`
  collection keyed by 40-hex oid, isomorphic-git plumbing only, nested trees
  supported, text-only content, no refs, no GC (roots enumerated in its header).
- Chat code model (post git-storage.md Part 3): OT `chatChanges` rows
  (`CodeChange` keyed by `WorkpieceId`), lazy pins `{gadgetId, baseCommit}` +
  `mergedCommit`, epochs bounded by `mergeChanges`' reset, `buildChatContent` folding
  the log, agent session content as `Map<WorkpieceId, Map<path, string>>`.
- Workpiece dispatch seams (the four places that know gadget-vs-gatekeeper):
  `resolveWorkpieceRoot`, `getEnvForAgent`/`makeBindingLoopback`, `describeBinding`,
  and the pinned/unpinned split in the agent file tools.
- Observations: `OverseerImpl.authorizeObservation(gatekeeperId, description, caller)`
  is the single chokepoint where every gatekeeper observation is recorded (via
  `ApprovalQueueImpl`); `recordAgentObservation` covers built-in tools.
- GitHub gatekeeper: REST-only today; `GitHubRepo` session has the
  "TODO: Add methods to access code" comment; observer verification is strategy B
  (repo-level ACL via `GitHubVerifier.hasRepoAccess`), which covers git data too —
  git objects inherit the repo ACL.
- Precedent for the protocol work: `gatekeeper-context/src/artifact-sync.ts` proves
  isomorphic-git 1.40 smart-HTTP fetch works in workerd (we reuse its pack-parsing
  internals, not its high-level fetch).

## Design

### 1. Git cache + provenance (workshop-backend)

- **`GitCacheImpl`** implements the shared `GitCache` interface over the existing
  `gitObjects` collection. The cache API speaks `(type, headerless payload)`;
  storage stays zlib'd whole loose objects. `put()` computes the SHA-1 of
  `<type> <size>\0` + payload itself and stores under that oid — poison-proof by
  construction; a gatekeeper that gets back an unexpected oid should throw.
  Likely API addition while finalizing the shared types: `putMany()` (or explicitly
  blessing pipelined un-awaited `put()`s) — unpacking a packfile is thousands of
  objects and one awaited RPC each is needless.
- **`gitProvenance` collection**, keyed `(oid, gatekeeperId)` where `gatekeeperId` is
  the `GatekeeperRecord`'s `WorkpieceId` (the gatekeeper DO is per-resource, so this
  identifies the repo too). Multiple gatekeepers may claim the same oid. Rows are
  written at exactly two points:
  1. `authorizeObservation`, when `ObservationDescription.gitCommits` is present —
     the advertised commits become pullable from that gatekeeper.
  2. `GitCacheImpl.put()` during a `gitPull` — everything a gatekeeper supplies is
     re-pullable from it (the "populated in the past, since evicted" case).
  Transitive references (a pulled commit's tree, a tree's subtrees/blobs) gain rows at
  fault time: the pull driver knows the `referencedBy` chain it is walking.
- **Pull driver** `ensureGitObjects(oids, hints)` in the overseer: look up provenance
  (trying each recorded gatekeeper on failure), mint the gatekeeper stub through the
  existing `getGatekeeperClassFor` chokepoint (so disabled gatekeepers/resources stay
  enforced), call `gitPull(oids, cache, hints)`, verify the requested oids are now
  present. A deleted gatekeeper record → clear error to the agent ("reconnect X to
  pull this commit").
- **Fault handling wraps GitStore reads**, keeping the fs shim synchronous-shaped:
  worktree-path readers catch isomorphic-git's NotFoundError (it names the missing
  oid), resolve provenance, pull, retry. Gadget-history reads never fault (their
  objects are always local).
- **git-store extensions**:
  - Raw object read/write helpers used by the cache impl (inflate/deflate + header
    split), private to git-store + cache.
  - `readFileAtCommit(oid, path)` — per-path tree walk, no full-tree materialization.
  - `listTreeEntries(oid, path?)` / tree-walk helpers for `listFiles` and grep
    enumeration (tree objects are always local — trees are eager).
  - `writeChangedFilesAsCommit(parentCommit, changes: Map<path, string | null>)` —
    builds the new tree by reusing unchanged subtree oids from the parent, so
    committing at repo scale never materializes the full file map (`null` = delete).
- `ApprovalQueueImpl` (and `SlashCommandAuthorizerImpl`) implement `getGitCache()`.

### 2. Worktree workpiece (workshop-backend + workshop-shared)

- **`worktrees` collection**: `{id, title, bindingName, chatId, sourceGatekeeperId,
  baseCommit, headCommit, pinBase, created}`.
  - `id` from the shared workpiece counter (`allocateWorkpieceId`) — facet names and
    `CodeChange` keys can never collide with gadgets/gatekeepers.
  - `headCommit` = last **explicit** commit (initially `baseCommit`); what the
    worktree API reports and what explicit commits parent on.
  - `pinBase` = the commit the chat's current pin is rooted at — `headCommit` or the
    latest auto-commit. Internal bookkeeping only, never surfaced.
  - `bindingName` shares the gadget binding-name uniqueness space? **No** — worktrees
    are chat-scoped and invisible outside their chat, so their names live in the
    *chat binding* namespace only (validated against the chat's existing bindings,
    like other chat-local bindings), not in the workspace-wide `byBindingName` index.
  - Deleted when their chat is deleted (extend chat deletion cleanup).
- **`createWorktree` agent tool**, mirroring `createGadget`'s shape: validate the
  binding name against the chat scope; resolve the commit id against **known
  provenance** — full oid or unambiguous prefix (prefix scan over `gitProvenance`;
  ambiguous → error listing candidates; unknown → "look it up via the gatekeeper
  first"); flush barrier; create the record; add the chat binding; record
  `{worktreeId, changeId}` as the tool output so replay never re-creates. Creation
  performs the **initial pull**: `gitPull([commit], cache, {type: "commit",
  commitHistory: {kind: "depth", depth: 1}, filterBlobSize: EAGER_BLOB_LIMIT})` —
  one fetch for commit + all trees + small blobs.
- **Pin at birth**: creation declares the pin `{gadgetId: worktreeId, baseCommit}` on
  the same `"changes"` batch that records the creation (like `createdGadgets`), so
  `buildChatContent` reconstruction works from the log alone.
- **File-tool dispatch** — extend the four seams:
  - `resolveWorkpieceRoot`: accept worktree ids for the chat that owns them (other
    chats' worktrees are invisible, like other chats' pending gadgets).
  - Agent tools: worktrees are always pinned, so reads are session-content reads
    (unstamped — the `observedCommit`/elision matrix never applies), and the
    read-before-edit gate works as-is. `writeFile`/`editFile` emit ordinary OT rows.
  - **System prompt**: list the worktree binding with metadata (name, source repo,
    head commit, file/dir count) but **never** its file list — repo-scale lists don't
    belong in the prompt. Discovery goes through the binding API (and grep).
  - `getEnvForAgent`/`makeBindingLoopback`: third loopback type minting the
    `Worktree` RpcTarget.
  - `describeBinding`: returns the agent-API section of `worktree.d.ts` (the
    `---- BEGIN AGENT API ----` marker), following the `agent-spawner-binding.txt`
    pattern for shipping the text.
- **Lazy content in the OT machinery**: `buildChatContent` / session content for
  worktree roots must not materialize the whole tree. Applying a `CodeChange` needs
  base text only for *touched* paths; reads resolve through
  `readFileAtCommit(pinBase, path)` (fault-pulling the blob if missing). Content maps
  for worktree ids hold only touched/read files over a lazy base resolver.
  Oversized/binary base files: clean tool error on read; a `set` (whole-file write)
  is still allowed on any path.
- **Epoch reset in `mergeChanges`**: after commits land and pins reset, for each
  worktree with net changes in the closed epoch, write an auto-commit via
  `writeChangedFilesAsCommit(pinBase, touchedFiles)`, set `pinBase` to it, and re-pin
  the worktree in the new generation (same batch that opens the epoch). `headCommit`
  is untouched. Worktrees never gate accept (no mainline record, no staleness).
- **`Worktree` binding API** (finalize `worktree.d.ts`; the `TODO(now)` file ops):
  - `listFiles(path?, options?: {recursive?: boolean}) → WorktreeEntry[]` (name,
    type file/dir, size).
  - `readFile(path) → string`, `writeFile(path, text)`, `deleteFile(path)` — text
    oriented; writes/deletes are OT rows exactly like the file tools' (they go
    through the same append hook, so replay and the UI-someday subscription see
    them).
  - `grep(path, pattern)` / `structuredGrep(path, pattern)` — regex over a file or
    recursively over a directory; **one batched fetch** fills any missing blobs
    before matching; files over the size cap (and binaries) are skipped, with a note
    in the output. (`RegExp` params are fine: the binding is served over Workers RPC
    inside the server, which has always supported RegExp serialization.)
  - `commit(message) → oid` — flatten current content changes vs. `headCommit`'s
    tree (diff `headCommit`→`pinBase` plus the live overlay's touched paths), write
    with parent = `headCommit`, advance `headCommit` (and `pinBase`) to it. Commit
    identity from the chat owner via `commitIdentityForAuthor`. The returned oid is
    naturally replay-stable: executeCode results are recorded, and content-addressed
    writes are idempotent across crashes.
  - `diff(commitId?) → string` — unified diff of current content vs. the given
    commit (default `headCommit`). Needs a small git-style unified-diff formatter
    (new utility; we have diff engines but no printer). `commitId` may be any local
    commit (e.g. `baseCommit` to see all changes since mount).
  - Punted, recorded in the .d.ts as future work: `merge`, `reset` (hard reset =
    create a new worktree).

### 3. GitHub gatekeeper: git operations (gatekeeper-github)

- **Session API** — extend `GitHubRepo` (this is the `types.d.ts` TODO), all
  observations, all stamping `gitCommits` with every commit id they return:
  - `listBranches(filter?) → Cursor<{name, headCommit, ...}>`
  - `listTags(filter?) → Cursor<{name, commit, ...}>`
  - `getCommit(ref) → CommitDetails` — full/truncated SHA, branch, or tag; REST
    `/repos/{o}/{r}/commits/{ref}` resolves truncated ids natively. This is the
    agent's path for "a code comment mentions abc1234".
  - `listCommits({branch?, path?, since?, ...}) → Cursor<CommitSummary>` — history
    enumeration.
  - `GitHubPullRequest.listCommits() → Cursor<CommitSummary>`.
  - Stamp `gitCommits` on existing SHA-bearing observations too (`readDiff`'s
    base/head SHAs, `getDetails` branch refs).
  - Observer verification: unchanged — strategy B's repo ACL covers git data.
- **`gitPull(oids, cache, hints)`** on the gatekeeper DO (`GitHubGatekeeperImpl`):
  - Smart-HTTP protocol v2 `fetch` against `https://github.com/{o}/{r}.git`
    (token auth): hand-composed pkt-line; `want` per requested oid; `shallow`/
    `deepen`/`deepen-since` from `hints.commitHistory` (default depth 1);
    `filter blob:limit=N` from `filterBlobSize` (and `tree:<depth>` when
    `filterTreeDepth` is set); `have`s from remembered previously-fetched tips
    (stored in the DO; best-effort only — shallow pulls make missing `have`s cheap);
    immediate `done`, single round.
  - Parse the returned pack — reusing isomorphic-git's pack parsing / delta
    resolution internals if reachable, else a small hand-rolled parser (wire packs
    contain ofs/ref deltas; resolution is the only nontrivial part) — and `put`
    every unpacked object into the `GitCache`. Nothing retained locally except the
    fetched-tips memory.
  - Blob faults: individual/batched blob `want`s over the same fetch command
    (partial-clone lazy fetch — this is exactly what git itself does against
    GitHub).
- **Push** — queued action `push(branch, commitId, {force?})`:
  - Queue: validates `commitId` exists in the `GitCache`; description names repo,
    branch, commit, force-ness. Simulation overlays the pending push onto
    `listBranches`/`getCommit` reads per the write-gatekeeper simulation convention.
  - Apply: walk the object graph from `GitCache.get()` starting at `commitId`,
    stopping at objects the remote is known to have (remembered tips / the branch's
    current sha); build an undeltified pack (isomorphic-git `packObjects` or
    equivalent over the raw objects); send-pack to receive-pack with the ref-update
    command (`old-sha new-sha refs/heads/branch`, zero-id old-sha creates the
    branch; non-force update requires old-sha match — a stale old-sha fails apply
    with a clear error). Record `previousSha` as revert info; revert = ref rollback
    (or delete, if the push created the branch).
  - "Create a PR from a commit" = `push` to a branch + the existing
    `createPullRequest` (document the flow in types.d.ts; add a convenience only if
    it earns its keep).

### 4. Shared API finalization (workshop-shared)

- The `gatekeeper.ts` types from 2500f71 land essentially as sketched, with:
  - `putMany()` (or the pipelining note) on `GitCache`.
  - `GitPullHints.commitHistory` optional, defaulting to `{kind: "depth", depth: 1}`.
  - Doc comments to the kernel review bar on every export; `@validateRpc()` per
    repo convention on RPC interfaces.
- `worktree.d.ts` finalized per §2 (file ops filled in, commit-squash semantics
  documented from the *agent's* point of view — i.e. not documented at all: the API
  simply reports the last explicit commit as HEAD).
- No `api.ts` (client protocol) changes: worktrees are invisible to the frontend.

## Constants (tunable, named in one place)

- `EAGER_BLOB_LIMIT` — blob size fetched eagerly at worktree creation (~256KB).
- `MAX_WORKTREE_FILE_SIZE` — hard per-file support cap (~1MB; must respect the
  existing `MAX_FILE_TEXT_LENGTH` UTF-16 and 2MB-record constraints).

## Verification spikes (early, cheap, before the transport commits)

1. **GitHub upload-pack capabilities** against a live repo: protocol v2 fetch with
   SHA `want`s for commits *and* blobs, `shallow` combined with `filter`,
   `blob:limit` and `tree:<depth>` support. (Partial-clone lazy fetch implies blob
   wants work; verify rather than assume — the repo's own AGENTS.md pattern.)
2. **isomorphic-git pack parsing reusability**: can its pack/delta machinery be
   driven standalone (without its fs/gitdir assumptions), or do we write the
   ~200-line parser ourselves?

## Known edge cases / watch-fors

- **Provenance loss**: a disconnected/deleted gatekeeper record makes its objects
  unpullable. No eviction in v1 means already-pulled objects keep working; only
  *new* faults fail, with an actionable error.
- **Prefix resolution** in `createWorktree` is against *local provenance only* —
  never a remote lookup. Remote truncated-id resolution is `getCommit(ref)` on the
  gatekeeper, which returns (and advertises) the full oid.
- **Auto-commit chains**: `pinBase` may advance through several auto-commits across
  several accepts before an explicit `commit()`. The explicit commit's changed-file
  set must be computed vs. `headCommit` (tree diff `headCommit`→`pinBase` unioned
  with the live overlay), not vs. `pinBase`.
- **`mergeChanges` staleness**: worktree pins must be excluded from the fast-forward
  gate (no mainline head to compare) and from `updateChatFromMainline`'s stale set.
- **Compaction**: checkpoint pins already carry `{gadgetId, baseCommit}`; worktree
  pins ride along unchanged. Verify checkpoint `proposedChange` composition handles
  worktree ids (it should — ids are opaque).
- **Chat deletion**: delete worktree records + chat bindings; objects stay (no GC,
  dangling is fine and consistent with gadget history behavior).
- **Turn abort / revert**: worktree OT rows are erased like any others (generation
  bump); `headCommit`/`pinBase` only advance via explicit commit / epoch reset, both
  of which are durable log events, so record state never references erased content.
  Verify `commit()` mid-turn vs. a subsequent turn abort: the commit object exists
  (harmless, dangling) but `headCommit` advancement rides the recorded executeCode
  result — an aborted turn must roll `headCommit` back or the abort must be refused
  after a commit; decide during implementation and test it.
- **Pack parsing is hostile-input parsing**: the pack comes from GitHub over TLS,
  but parse defensively anyway (bounded allocations, no trust in claimed sizes) —
  and `GitCache.put()`'s hash verification is the backstop for object *content*.
- **Rate/size limits**: one fetch per worktree creation and per batch fault keeps
  request counts trivial; the transfer-size limiter pattern from artifact-sync
  (64MB) should wrap the fetch body.

## Commit sequence

Ordered so kernel diffs are isolated and reviewable apart from the gatekeeper work
(AGENTS.md kernel bar); each commit builds/tests green unless noted. PR boundaries
to be decided later.

1. **shared: git cache API** (workshop-shared) — finalize changes from 2500f71:
   `gatekeeper.ts` additions (`GitCache` incl. `putMany`, `GitPullHints` defaults,
   `Gatekeeper.gitPull`, `ObservationAuthorizer.getGitCache`,
   `ObservationDescription.gitCommits`), fully doc-commented. No implementation
   yet; overseer gains a stub `getGitCache` so the tree compiles.
2. **backend: git cache + provenance + pull driver** — `GitCacheImpl`,
   `gitProvenance` collection, provenance recording at `authorizeObservation` and
   `put()`, `ensureGitObjects` + fault-retry wrapper, git-store extensions
   (`readFileAtCommit`, `listTreeEntries`, `writeChangedFilesAsCommit`, raw object
   helpers). Workerd tests: cache round-trips vs known-good git hashes, poison
   rejection, provenance at both write points, fault-pull-retry with a mock
   gatekeeper, changed-files commits reusing subtree oids.
3. **backend: worktree records + createWorktree + file tools** — `worktrees`
   collection, `createWorktree` tool (prefix resolution, initial pull, recorded
   output, birth pin), the four dispatch seams, lazy content for worktree roots in
   `buildChatContent`/session content, system-prompt metadata line. Tests:
   create/replay determinism, edit-through-OT on a worktree, lazy blob fault,
   oversize/binary read errors, chat-deletion cleanup, other-chat invisibility.
4. **backend: epochs + Worktree binding API** — auto-commit + re-pin at
   `mergeChanges` reset (squash semantics), the `Worktree` RpcTarget (listFiles/
   readFile/writeFile/deleteFile/grep/structuredGrep/commit/diff), unified-diff
   formatter, `describeBinding` text, finalized `worktree.d.ts`. Tests: accept with
   dirty worktree preserves content and squashes (explicit commit parents on last
   explicit head after N accepts), commit determinism, diff output goldens, grep
   batch-fill (one pull for a directory of missing blobs), abort-after-commit
   behavior.
5. **github: session git reads** — `listBranches`/`listTags`/`getCommit`/
   `listCommits`/PR `listCommits`, `gitCommits` stamping (new + existing SHA-bearing
   observations), types.d.ts docs. Pure REST; no protocol code yet. Tests extend
   `github-api.test.ts` patterns.
6. **github: fetch transport + gitPull** — pkt-line composer/parser, protocol-v2
   fetch client (wants/shallow/filter/haves/done), pack unpacking into `GitCache`,
   fetched-tips memory, transfer-size limiting. Tests: pkt-line round-trips, pack
   fixtures produced by real git (incl. delta objects), hint mapping, tips-based
   have construction. (Spikes 1–2 land before or with this commit.)
7. **github: push + PR-from-commit** — `push` action (queue/simulate/apply/revert),
   object-graph walk with known-remote cutoff, pack building, send-pack; types.d.ts
   flow docs for push + createPullRequest. Tests: walk cutoff, ref-update encoding,
   force/non-force, revert to `previousSha`, branch-creation push.

## Punted / future work (deliberately kept open)

- Worktree UI (changes view, diffs) — the OT stream + pins already carry everything
  a future subscription needs.
- Eviction/GC — provenance rows are the re-pull index; the GC-roots enumeration in
  git-store.ts gains "worktree `headCommit`/`pinBase`/`baseCommit`" when it happens.
- Binary and >1MB file editing; `putStream()` for large blobs.
- Cross-chat / workspace-scoped worktrees; user editing of worktrees.
- `merge` / `reset` on the Worktree API.
- Deep-history pulls (`commitHistory: full/since` are specified but GitHub-side
  usage ships shallow-only defaults).
- Other git hosts (the gatekeeper interface is host-neutral by construction).
