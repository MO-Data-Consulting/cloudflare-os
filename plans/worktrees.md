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

The starting point is the sketch in commit 2500f71, encompassing changes in
`workshop-shared/src/gatekeeper.ts` (`GitOid`/`GitObjectType`/`GitCache`/
`GitPullHints`, `Gatekeeper.gitPull?()`, `ObservationAuthorizer.getGitCache()`,
`ObservationDescription.gitCommits?`) and `workshop-shared/src/worktree.d.ts` (the
agent-facing `Worktree` binding API).

## Locked decisions

- **Chat-scoped.** A worktree belongs to the chat that created it and is deleted with
  the chat. Fresh agents create their own worktrees. Nothing structural forbids
  workspace-scoped worktrees later (worktrees get ordinary `WorkpieceId`s from the
  shared counter), but no cross-chat visibility ships now.
- **No UI.** Worktrees do not appear in the workshop UI at all — a future change can
  add a `WorkpieceSummary` variant when the UI is ready for large repos. Since
  worktrees live in the unified workpiece table (below), `subscribeToWorkpieces` must
  filter them out by type.
- **Edits ride the existing chat OT stream.** `CodeChange` is already keyed by
  `WorkpieceId` and pins are `{gadgetId, baseCommit}`; a worktree is *born pinned* at
  its base commit, so readFile/writeFile/editFile, the read-before-edit gate,
  `chatChanges` rows, replay, and compaction all work unchanged. (The alternative — a
  worktree-local overlay — was rejected: agent replay needs content-at-each-point
  history, which is most of the OT stream rebuilt.)
- **One workpiece table.** Worktrees are stored in the existing `gadgets` collection,
  which generalizes: `GadgetRecord` becomes a `WorkpieceRecord` with a `type`
  discriminator. This avoids a second lookup to resolve what a `WorkpieceId` refers
  to and lets code handling gadget code vs. worktrees be shared. (Folding
  `GatekeeperRecord` into the same table may make sense eventually but is out of
  scope here.)
- **Worktrees have no `bindingName`.** The only purpose of `bindingName` on the
  record is to seed new chats' binding sets; worktrees are chat-private and never
  participate. Like the obsolete `GatekeeperRecord.bindingName`, the name a worktree
  was created under lives only in its chat's binding list. `bindingName` therefore
  becomes optional on the unified record (unset for chat-private workpieces), and
  worktree rows opt out of the `byBindingName` unique index by returning null (the
  pattern the gatekeepers table already uses) — so two chats can each have a worktree
  named `repo` without conflict.
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
- **Lazy reads are a hand-rolled walker, not isomorphic-git.** The new
  read-on-demand paths (per-path tree walk, entry listing, commit header reads) parse
  git objects themselves and call `ensureObject(oid, {type, referencedBy})` before
  each step, so pull hints and transitive provenance fall out of the walk naturally.
  isomorphic-git's fs shim only ever sees a bare oid path — it knows neither the
  expected type nor the `referencedBy` chain that `GitPullHints` wants — and the
  parsing is genuinely trivial (blob = raw bytes; tree = repeated
  `<mode> <name>\0<20-byte oid>`; commit = text headers) on top of the raw
  loose-object codec `GitCacheImpl` needs anyway. isomorphic-git remains the engine
  for the existing full-materialization paths and for **all writes** (which never
  fault), keeping the write side single-sourced; tests cross-verify the two codecs
  over the same store.
- **No eviction yet.** The `GitCache` contract *permits* eviction (that's why
  provenance exists — evicted objects are re-pullable), but v1 implements none.
  Provenance metadata is the future re-pull index; gadget-history objects remain
  rooted by records/pins as documented in git-store.ts.

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
  construction; a gatekeeper that gets back an unexpected oid should probably throw.
  No `putMany` batch method: the cache stub a gatekeeper holds is a facet-to-parent
  stub (always local), and callers are free to issue many `put()`s in parallel
  rather than awaiting each serially — doc-comment this on `put()`.
- **`gitObjectMetadata` collection**: one row per oid —
  `{oid, type?, size?, gatekeeperIds: WorkpieceId[]}` (array of gatekeeper ids
  rather than one row per pair, the idiomatic typed-storage shape). `gatekeeperId`
  is the `GatekeeperRecord`'s `WorkpieceId` (the gatekeeper DO is per-resource, so
  it identifies the repo too); multiple gatekeepers may claim the same oid. Kept
  separate from `gitObjects` for two reasons: reading a `gitObjects` row means
  reading the whole object content, which is wasteful when only metadata is wanted;
  and metadata can exist for objects we *don't* hold — commits advertised by an
  observation but never pulled, and oversized blobs we declined to store (recording
  their size lets a later `stat()`/read fail fast instead of refetching). Rows are
  written at:
  1. `authorizeObservation`, when `ObservationDescription.gitCommits` is present —
     the advertised commits become pullable from that gatekeeper.
  2. `GitCacheImpl.put()` during a `gitPull` — type/size recorded, the pulling
     gatekeeper added to `gatekeeperIds` (everything a gatekeeper supplies is
     re-pullable from it — the "populated in the past, since evicted" case).
  3. The lazy walker, for transitive references (a pulled commit's tree, a tree's
     subtrees/blobs): `ensureObject`'s `referencedBy` chain propagates provenance
     as it walks.
- **Pull driver** `ensureGitObjects(oids, hints)` in the overseer: look up
  provenance in `gitObjectMetadata` (trying each recorded gatekeeper on failure),
  mint the gatekeeper stub through the existing `getGatekeeperClassFor` chokepoint
  (so disabled gatekeepers/resources stay enforced), call
  `gitPull(oids, cache, hints)`, verify the requested oids are now present. A
  deleted gatekeeper record → clear error to the agent ("reconnect X to pull this
  commit").
- **Lazy walker** (`ensureObject` + hand-rolled parsers, per the locked decision):
  the read-side codec — loose-object header/inflate helpers shared with
  `GitCacheImpl`, plus tree/commit parsers — powering the new lazy read paths.
  `ensureObject(oid, {type, referencedBy})` checks presence, pulls via
  `ensureGitObjects` on a miss (recording provenance inherited from
  `referencedBy`), then parses. Gadget-history reads never fault (their objects are
  always local) and keep using isomorphic-git untouched.
- **git-store extensions**:
  - Raw object read/write helpers used by the cache impl and walker
    (inflate/deflate + header split), private to git-store + cache.
  - `readFileAtCommit(oid, path)` — per-path tree walk via the lazy walker, no
    full-tree materialization.
  - `listTreeEntries(oid, path?)` / walk helpers for `listFiles` and grep
    enumeration (tree objects are always local — trees are eager).
  - `writeChangedFilesAsCommit({treeBase, parents}, changes: Map<path, string |
    null>)` — builds the new tree by reusing unchanged subtree oids from
    `treeBase`, so committing at repo scale never materializes the full file map
    (`null` = delete). `treeBase` and `parents` are separate parameters: an
    explicit worktree commit builds its tree from `pinBase` but parents on
    `headCommit` (squash semantics). Writes go through isomorphic-git plumbing.
- `ApprovalQueueImpl` (and `SlashCommandAuthorizerImpl`) implement `getGitCache()`.

### 2. Worktree workpiece (workshop-backend + workshop-shared)

- **Unified workpiece table**: `GadgetRecord` generalizes to a `WorkpieceRecord`
  with a `type` discriminator (`"gadget"` | `"worktree"`); worktree rows add
  `{chatId, sourceGatekeeperId?, baseCommit, headCommit, pinBase}` and omit
  gadget-only fields (`output`, `bindings`).
  - `id` from the shared workpiece counter (`allocateWorkpieceId`) — facet names and
    `CodeChange` keys can never collide with gadgets/gatekeepers.
  - `bindingName` becomes **optional** and is unset for worktrees; worktree rows
    return null from the `byBindingName` index (see locked decision). The creation
    name lives only in the chat's binding list.
  - `chatId` is a permanent field (never cleared) — it is what makes the worktree
    chat-private, independent of the pending lifecycle below.
  - `headCommit` = last **explicit** commit (initially `baseCommit`); what the
    worktree API reports and what explicit commits parent on.
  - `pinBase` = the commit the chat's current pin is rooted at — `headCommit` or the
    latest auto-commit. Internal bookkeeping only, never surfaced.
  - **Lifecycle mirrors pending gadgets**: the record is born with
    `pending: {chatId, sequence}`, stamped by the same machinery, reaped by
    `reconcilePendingGadgets` on crash, and deleted if the creating change is
    reverted. Accept's promotion sweep clears `pending` (the creation is durable)
    but performs **no head-commit work** for worktrees — their head lifecycle is
    their own — and `chatId` keeps them chat-private forever.
  - Deleted when their chat is deleted (extend chat deletion cleanup).
  - **Consumer audit**: every reader of the `gadgets` collection must be checked to
    filter by type — `subscribeToWorkpieces` (else worktrees leak to the UI),
    `defaultBindingList` (worktrees never seed chats), promotion/reconciliation
    sweeps (no head-commit work), blueprint enumeration/creation, ambient
    reconciliation, and the loader paths.
- **`createWorktree` agent tool**, mirroring `createGadget`'s shape: validate the
  binding name against the chat's own binding map (the only namespace it occupies);
  resolve the commit id — full oid or unambiguous prefix — against the **local store
  and known metadata** (`gitObjects` ∪ `gitObjectMetadata`; ambiguous → error
  listing candidates; unknown → "look it up via the gatekeeper first"). There is no
  requirement that the commit came from a gatekeeper: any locally-present commit
  works (a gadget's history, another worktree's commit) and needs no provenance,
  since local-origin objects never fault. Then: flush barrier; create the record;
  add the chat binding; record `{worktreeId, changeId}` as the tool output so replay
  never re-creates. For gatekeeper-known commits, creation performs the **initial
  pull**: `gitPull([commit], cache, {type: "commit", commitHistory: {kind: "depth",
  depth: 1}, filterBlobSize: EAGER_BLOB_LIMIT})` — one fetch for commit + all trees
  + small blobs.
- **Pin at birth**: creation declares the pin `{gadgetId: worktreeId, baseCommit}` on
  the same `"changes"` batch that records the creation (like `createdGadgets`), so
  `buildChatContent` reconstruction works from the log alone.
- **File-tool dispatch** — extend the four seams:
  - `resolveWorkpieceRoot`: accept worktree ids for the chat that owns them (other
    chats' worktrees are invisible, like other chats' pending gadgets).
  - Agent tools: worktrees are always pinned, so reads are session-content reads
    (unstamped — the `observedCommit`/elision matrix never applies), and the
    read-before-edit gate works as-is. `writeFile`/`editFile` emit ordinary OT rows.
  - **System prompt**: one line per existing worktree (name, source repo, head
    commit) but **never** its file list — repo-scale lists don't belong in the
    prompt. No worktrees exist at chat start, but the prompt is rebuilt every turn,
    so turns after creation do list them — cheap insurance for post-compaction turns
    where the creation tool result may have been summarized away. Discovery goes
    through the binding API (and grep).
XXX Are you sure the system prompt can *change* turn-to-turn? If so this is actually pretty bad as it breaks the prompt cache. I thought that the system prompt was based on the starting state of the chat, and the agent was expected to understand how the state had changed based on the chat history. After a compaction, though, it makes sense that the system prompt should update, since the agent no longer sees the pre-compaction history (and, of course, the prompt cache is lost at compaction anyway).
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
  `writeChangedFilesAsCommit({treeBase: pinBase, parents: [pinBase]}, touchedFiles)`,
  set `pinBase` to it, and re-pin the worktree in the new generation (same batch that
  opens the epoch). `headCommit` is untouched. Worktrees never gate accept (no
  mainline record, no staleness).
- **`Worktree` binding API** (finalize `worktree.d.ts`; the `TODO(now)` file ops):
  - `listFiles(path?, options?: {recursive?: boolean}) → FileMetadata[]` (name,
    type file/dir, size).
  - `readFile(path) → string`, `writeFile(path, text)`, `deleteFile(path)` — text
    oriented; writes/deletes are OT rows exactly like the file tools' (they go
    through the same append hook, so replay and the UI-someday subscription see
    them). **`writeFile` on an existing, readable file diffs**: the OT row is a
    minimal edit computed via `diffFiles` (fast-diff) against current content, not
    a whole-file `set` — keeping rows and composed changes bounded by changed
    regions. `set` is used only for new files and for bases we can't read
    (oversized/binary). (The gadget `writeFile` *tool* emits whole-file `set`s
    today; adopting the same helper there is a cheap follow-up, out of scope here.)
  - `grep(path, pattern)` / `structuredGrep(path, pattern)` — regex over a file or
    recursively over a directory; **one batched fetch** fills any missing blobs
    before matching; files over the size cap (and binaries) are skipped, with a note
    in the output. (`RegExp` params are fine: the binding is served over Workers RPC
    inside the server, which has always supported RegExp serialization.)
  - `commit(message) → oid` — build the tree exactly the way `mergeChanges` would,
    except from the pin: `writeChangedFilesAsCommit({treeBase: pinBase, parents:
    [headCommit]}, overlayTouchedPaths)`. Current content ≡ `pinBase` tree +
    current-epoch overlay, so the overlay's touched paths are the *only* changes to
    apply — no diff computation anywhere. Advance `headCommit` (and `pinBase`) to
    the new commit. Commit identity from the chat owner via
    `commitIdentityForAuthor`. The returned oid is naturally replay-stable:
    executeCode results are recorded, and content-addressed writes are idempotent
    across crashes.
XXX The above bullet point has gotten kind of hard to understand (written in "Claudish"), could you rephrase it? In particular the fact that the new commit lists the head commit as its parent is technically covered but sort of de-emphasized; this is important!
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
    `deepen`/`deepen-since` from `hints.commitHistory`; `filter blob:limit=N` from
    `filterBlobSize` (and `tree:<depth>` when `filterTreeDepth` is set); `have`s
    from remembered previously-fetched tips (stored in the DO; best-effort only —
    shallow pulls make missing `have`s cheap); immediate `done`, single round.
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
  - `GitCache.put()` doc-noting that callers may (should) issue many puts in
    parallel; no batch method (the stub is facet-to-parent, always local).
  - `GitPullHints.commitHistory` stays **required** — a default would have to be
    either "full" (which we never intend to request) or an arbitrary depth; better
    to make every caller say what it means.
  - Doc comments to the kernel review bar on every export; `@validateRpc()` on the
    implementations (per repo convention — it goes on implementations, not
    interfaces).
- `worktree.d.ts` finalized per §2 (file ops filled in, commit-squash semantics
  documented from the *agent's* point of view — i.e. not documented at all: the API
  simply reports the last explicit commit as HEAD).
- No `api.ts` (client protocol) changes: worktrees are invisible to the frontend.

## Constants (tunable, named in one place)

- `EAGER_BLOB_LIMIT` — blob size fetched eagerly at worktree creation (64KB).
- `MAX_WORKTREE_FILE_SIZE` — hard per-file support cap (~1MB; must respect the
  existing `MAX_FILE_TEXT_LENGTH` UTF-16 and 2MB-record constraints).

## Verification spikes (early, cheap, before the transport commits)

1. **GitHub upload-pack capabilities** against a live repo: protocol v2 fetch with
   SHA `want`s for commits *and* blobs, `shallow` combined with `filter`,
   `blob:limit` and `tree:<depth>` support. (Partial-clone lazy fetch implies blob
   wants work; verify rather than assume — the repo's own AGENTS.md pattern.)
   Include: does `filter blob:limit` suppress **explicitly wanted** blobs? This
   decides the oversized-blob fault path — either the wanted blob never arrives
   (→ `gitObjectMetadata` marks it oversized so we don't refetch) or it arrives
   huge (→ the transfer limiter and `put()`'s size rejection handle it, then
   metadata records the size). Both are handled; the fetch client needs to know
   which happens.
2. **isomorphic-git pack parsing reusability**: can its pack/delta machinery be
   driven standalone (without its fs/gitdir assumptions), or do we write the
   ~200-line parser ourselves?

## Known edge cases / watch-fors

- **Provenance loss**: a disconnected/deleted gatekeeper record makes its objects
  unpullable. No eviction in v1 means already-pulled objects keep working; only
  *new* faults fail, with an actionable error.
- **Prefix resolution** in `createWorktree` is against *local knowledge only*
  (`gitObjects` ∪ `gitObjectMetadata`) — never a remote lookup. Remote
  truncated-id resolution is `getCommit(ref)` on the gatekeeper, which returns
  (and advertises) the full oid.
- **Auto-commit chains**: `pinBase` may advance through several auto-commits across
  several accepts before an explicit `commit()`. This costs nothing at commit time:
  the tree is always built from `pinBase` + the current epoch's overlay (pre-reset
  changes are already inside `pinBase`'s tree), and only the *parent* pointer names
  `headCommit`.
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
   `gatekeeper.ts` additions (`GitCache` with the parallel-`put` doc note,
   `GitPullHints` with `commitHistory` required, `Gatekeeper.gitPull`,
   `ObservationAuthorizer.getGitCache`, `ObservationDescription.gitCommits`), fully
   doc-commented. No implementation yet; overseer gains a stub `getGitCache` so the
   tree compiles.
2. **backend: git cache + provenance + pull driver** — `GitCacheImpl`,
   `gitObjectMetadata` collection (type/size/gatekeeperIds), metadata recording at
   `authorizeObservation` and `put()`, `ensureGitObjects` pull driver, the lazy
   walker (`ensureObject`, hand-rolled tree/commit parsers over the shared raw
   codec), git-store extensions (`readFileAtCommit`, `listTreeEntries`,
   `writeChangedFilesAsCommit` with separate treeBase/parents, raw object helpers).
   Workerd tests: cache round-trips vs known-good git hashes, poison rejection,
   metadata at all three write points, fault-pull-retry with a mock gatekeeper,
   walker output cross-verified against isomorphic-git over the same store,
   changed-files commits reusing subtree oids.
3. **backend: worktree records + createWorktree + file tools** — `GadgetRecord` →
   `WorkpieceRecord` (`type` discriminator, optional `bindingName`, null-index
   opt-out) with the full consumer audit (`subscribeToWorkpieces`,
   `defaultBindingList`, promotion/reconciliation, blueprint enumeration, loader
   paths), `createWorktree` tool (local + metadata prefix resolution,
   gatekeeper-free commits allowed, initial pull, recorded output, birth pin,
   pending lifecycle), the four dispatch seams, lazy content for worktree roots in
   `buildChatContent`/session content, system-prompt one-liner. Tests:
   create/replay determinism, create-from-local-commit (no gatekeeper),
   edit-through-OT on a worktree, lazy blob fault, oversize/binary read errors,
   revert-deletes-worktree, chat-deletion cleanup, other-chat invisibility, no
   UI/binding-seed leakage.
4. **backend: epochs + Worktree binding API** — auto-commit + re-pin at
   `mergeChanges` reset (squash semantics), the `Worktree` RpcTarget (listFiles/
   readFile/writeFile/deleteFile/grep/structuredGrep/commit/diff, with
   diff-based `writeFile`), unified-diff formatter, `describeBinding` text,
   finalized `worktree.d.ts`. Tests: accept with dirty worktree preserves content
   and squashes (explicit commit parents on last explicit head after N accepts,
   tree built from pinBase + overlay only), commit determinism, `writeFile` emits
   minimal edits (and `set` for new/unreadable files), diff output goldens, grep
   batch-fill (one pull for a directory of missing blobs), abort-after-commit
   behavior.
5. **github: session git reads** — `listBranches`/`listTags`/`getCommit`/
   `listCommits`/PR `listCommits`, `gitCommits` stamping (new + existing SHA-bearing
   observations), types.d.ts docs. Pure REST; no protocol code yet. Tests extend
   `github-api.test.ts` patterns.
6. **github: fetch transport + gitPull** — pkt-line composer/parser, protocol-v2
   fetch client (wants/shallow/filter/haves/done), pack unpacking into `GitCache`,
   fetched-tips memory, transfer-size limiting, oversized-blob handling per spike 1.
   Tests: pkt-line round-trips, pack fixtures produced by real git (incl. delta
   objects), hint mapping, tips-based have construction. (Spikes 1–2 land before or
   with this commit.)
7. **github: push + PR-from-commit** — `push` action (queue/simulate/apply/revert),
   object-graph walk with known-remote cutoff, pack building, send-pack; types.d.ts
   flow docs for push + createPullRequest. Tests: walk cutoff, ref-update encoding,
   force/non-force, revert to `previousSha`, branch-creation push.

## Punted / future work (deliberately kept open)

- Worktree UI (changes view, diffs) — the OT stream + pins already carry everything
  a future subscription needs.
- Eviction/GC — `gitObjectMetadata` is the re-pull index; the GC-roots enumeration
  in git-store.ts gains "worktree `headCommit`/`pinBase`/`baseCommit`" when it
  happens.
- Binary and >1MB file editing; `putStream()` for large blobs.
- Cross-chat / workspace-scoped worktrees; user editing of worktrees.
- `merge` / `reset` on the Worktree API.
- Unifying `GatekeeperRecord` into the workpiece table.
- Diff-based `writeFile` for the gadget writeFile agent tool (same helper).
- Deep-history pulls (`commitHistory: full/since` are specified but GitHub-side
  usage ships shallow-only defaults).
- Other git hosts (the gatekeeper interface is host-neutral by construction).
