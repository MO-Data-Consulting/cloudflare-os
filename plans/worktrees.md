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
  **provenance tracking** (which gatekeeper each object can be pulled from), lazy
  **pull-on-fault** plumbing (`Gatekeeper.gitPull()`), and **push authorization**
  (`ActionDescription.pushedCommits`, verified and marked at `submitAction`).
- **GitHub gatekeeper git operations**: enumerate branches/tags, look up commits
  (including truncated ids), enumerate commit histories and PR commits, push commits
  to a branch, create PRs from pushed commits — every commit-returning observation
  populating `ObservationDescription.gitCommits`, every push declaring
  `ActionDescription.pushedCommits`.

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
- **No UI — enforced by server-side delivery filtering.** Worktrees do not appear in
  the workshop UI at all; a future change can add a `WorkpieceSummary` variant when
  the UI is ready for large repos. This takes more than filtering
  `subscribeToWorkpieces`: the frontend's OT client consumes the same chat change
  stream the agent writes, and when a row touches a pinned workpiece it fetches the
  entire base commit (`otClient.ts` → `getCodeAtCommit`) — for a worktree that would
  be a whole repo, materialized on both ends of the wire. So the server strips
  worktree content from **every client delivery**: `changeApplied` events and
  subscribe-replay rows (worktree entries removed; revision numbers preserved, so a
  stripped row may carry an empty change but the revision stream stays gapless),
  delivered `"changes"`/`"merge"` messages' change payloads and pins, and `codeBase`
  metadata pins. This is sound because `CodeChange` transform is per-workpiece: ids
  are disjoint, so a client's gadget edits transform identically against a stripped
  row and the original — and clients can never author worktree changes, since they
  have no UI for them. (Frontend-side "ignore unknown ids" was rejected: the
  client's workpiece list arrives on a different subscription than the change
  stream, so classification would race.)
- **Edits ride the existing chat OT stream.** `CodeChange` is already keyed by
  `WorkpieceId` and pins are `{gadgetId, baseCommit}`; a worktree is *born pinned* at
  its base commit, so readFile/writeFile/editFile, the read-before-edit gate,
  `chatChanges` rows, replay, and compaction all work unchanged. Agent-authored rows
  are born at the step persistence barrier per plans/step-transactionality.md — a
  prerequisite of this plan — so worktree edits and `commit()` head advancements
  inherit its transactional crash semantics. (The alternative — a worktree-local
  overlay — was rejected: agent replay needs content-at-each-point history, which is
  most of the OT stream rebuilt.)
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
- **The chat's pin moves only at epoch boundaries; explicit `commit()` moves only
  `headCommit`.** This is what keeps the OT stream coherent: the pin (and record
  `pinBase`) is the base the epoch's OT rows compose on, and those rows remain the
  single durable record of the overlay — if `commit()` also advanced the pin to a
  commit already containing the overlay, replaying the still-active rows on top
  would apply every edit twice. So `commit()` changes nothing about how chat
  content is computed; it just snapshots it.
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
  fidelity. The pack bytes themselves are composed overseer-side
  (`GitCache.buildPack()`, §1); the gatekeeper contributes only send-pack framing
  and the ref-update command.
- **Push authorization is declared on the action and enforced at `submitAction` —
  there are no read-time rules and no gatekeeper-induced pulls.**
  `ActionDescription.pushedCommits` names the commits an action will push; before
  queuing, the overseer verifies that their ancestry reaches commits *proven* on
  that gatekeeper's remote and marks the push closure "pending push" (§1). The
  gatekeeper's whole cache view is then trivial: `get()`/`has()`/`stat()` answer
  for objects proven on its remote plus objects pending push to it, and nothing
  else. Proof means hash-verified bytes — a `put()` from that gatekeeper or a
  successful push to it; an advertisement is just an assertion and never
  qualifies (§1's metadata grades). The design serves two purposes, and neither
  is defense against a hostile gatekeeper (see the trust-model watch-for): the
  ancestry rule is a **safeguard against agent and user mistakes** — an
  accidental push to an unrelated remote fails closed at queue time with an
  agent-visible error (relatedness is proven by first pulling a shared ancestor
  from the destination, which is also what keeps pushes from ever needing to
  un-shallow the cache) — and the pending-push view is exactly what the
  gatekeeper needs to **simulate a not-yet-approved push**. Beyond those two,
  the tight view is least-authority hygiene rather than a security boundary.
  Versus the read-time-rules and `GitCache.ensure()` designs this replaced:
  repo *copying* stays structurally out of scope (cross-remote transfer moves
  only a verified push closure, batched at apply), and everything happens at
  the same chokepoint every other gatekeeper effect already flows through.
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
  each step, so pull hints fall out of the walk naturally.
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
  The metadata rows (`onRemote`/`pullableFrom`, §1) are the future re-pull index;
  gadget-history objects remain rooted by records/pins as documented in
  git-store.ts.

## Current-state anchors (for orientation)

- Object store: `git-store.ts` — SHA-1 zlib loose objects in the `gitObjects`
  collection keyed by 40-hex oid, isomorphic-git plumbing only, nested trees
  supported, text-only content, no refs, no GC (roots enumerated in its header).
- Chat code model (post git-storage.md Part 3): OT `chatChanges` rows
  (`CodeChange` keyed by `WorkpieceId`), lazy pins `{gadgetId, baseCommit}` +
  `mergedCommit`, epochs bounded by `mergeChanges`' reset, `buildChatContent` folding
  the log, agent session content as `Map<WorkpieceId, Map<path, string>>`.
- Step barrier (post step-transactionality.md, this plan's prerequisite): agent
  tool effects buffer in memory per model step and persist transactionally with
  the step's tool-call message at the `turn_end` barrier — agent rows are born
  and retired in one storage transaction, live `chatChanges` rows are
  user-authored only, and a mid-step crash leaves no durable trace of the step.
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

### 1. Git cache + provenance + push authorization (workshop-backend)

- **`GitCacheImpl`** implements the shared `GitCache` interface over the existing
  `gitObjects` collection. The cache API speaks `(type, headerless payload)`;
  storage stays zlib'd whole loose objects. The stub is minted **per-gatekeeper**
  — it identifies the writer for metadata recording and scopes the read view:
  - `put()` computes the SHA-1 of `<type> <size>\0` + payload itself and stores
    under that oid — poison-proof by construction; a gatekeeper that gets back an
    unexpected oid should probably throw. A verified `put()` doubles as the
    system's **proof of possession**: it is what earns the putter an `onRemote`
    mark (below). No `putMany` batch method: the cache stub a gatekeeper holds is
    a facet-to-parent stub (always local), and callers are free to issue many
    `put()`s in parallel rather than awaiting each serially — doc-comment this on
    `put()`.
  - `get(oid, hints?)` — and `has()`/`stat()` identically; the view is uniform
    across all three — answers **exactly** `onRemote(G) ∪ pendingPush(G)` for
    the calling gatekeeper G, null for everything else. Null is deliberately
    uniform: "not something this gatekeeper is involved with" and "on your own
    remote — ask it yourself, that's your job" look the same, and the fallback
    behaves correctly either way. A `pendingPush(G)` object that is locally
    absent is **pulled through** from its recorded source on demand — this is
    what lets the gatekeeper simulate a queued cross-remote push as if it had
    already landed; an absent `onRemote(G)` object is *not* pulled (null). The
    optional `hints: GitPullHints` are advisory prefetch for that pull-through,
    so a gatekeeper walking objects by hand doesn't fault once per `get()`
    (defaults: exact-object, type from metadata). Doc-comment the simulation
    contract: a returned commit that is pending push should be treated, for
    simulation purposes, as already pushed.
  - `buildPack()` returns a `ReadableStream` of an undeltified packfile (SHA-1
    trailer) carrying the applying action's full pending-push closure. It takes
    **no arguments**: the commit list is the action's own
    `ActionDescription.pushedCommits`, and the method exists only on the
    **action-scoped** stub passed to `applyAction()` (which carries the action
    id; a session-time stub has no action and throws) — that binding is what
    disambiguates overlapping queued pushes, duplicate heads, and multiple
    actions marking the same oids. Composed overseer-side from the `pushMarks`
    index (below), so apply needs no per-object RPC. `buildPack()` is
    responsible for **completing the closure**: any marked object absent from
    cache is faulted in from its recorded sources (batched), and a faulted
    tree's arrival propagates marks to its children (the ordinary lazy
    propagation), which may fault in turn — repeating until no marked object
    is absent. A mid-stream source-pull failure (provenance loss) fails the
    apply with the actionable "reconnect X" error. The stream rides
    facet-to-parent Workers RPC, which carries `ReadableStream` natively; the
    API deliberately leaves room for a future implementation that streams a
    source gatekeeper's pack straight through without staging every object.
- **`gitObjectMetadata` collection**: one row per oid — `{oid, type?, size?,
  onRemote: WorkpieceId[], pullableFrom: WorkpieceId[], pendingPush:
  {gatekeeperId: WorkpieceId, actionId}[]}` (arrays rather than one row per pair,
  the idiomatic typed-storage shape). Gatekeeper ids are the `GatekeeperRecord`'s
  `WorkpieceId` (the gatekeeper DO is per-resource, so it identifies the repo
  too); multiple gatekeepers may appear on the same oid. Kept separate from
  `gitObjects` for two reasons: reading a `gitObjects` row means reading the
  whole object content, which is wasteful when only metadata is wanted; and
  metadata routinely exists for objects we *don't* hold — advertised commits,
  filtered-out tree entries, and oversized blobs we declined to store (recording
  their size lets a later `stat()`/read fail fast instead of refetching). The two
  gatekeeper sets differ in **evidentiary grade** — proof versus assertion —
  which is what keeps the mistake-safeguard reliable:
  - `onRemote` — *proof* that the gatekeeper's remote possesses the object.
    Entered only by a hash-verified `put()` from that gatekeeper (during
    `gitPull`, or opportunistically alongside an observation — a gatekeeper may
    `put()` a commit's bytes when it stamps `gitCommits`, upgrading its
    advertisement to proof) or by a successful push to it. This is what
    `get()` serves, what ancestry verification terminates on, and what the
    marking walk skips.
  - `pullableFrom` — unproven *hints*: `ObservationDescription.gitCommits`
    advertisements (written at `authorizeObservation`), plus the referent oids
    recorded whenever a gatekeeper `put()`s a tree or commit (each entry / tree
    pointer / parent, type derived from the entry mode or header — this is what
    creates rows for objects never fetched, and the sketch's "referenced by
    another object populated by this gatekeeper" and "populated in the past,
    since evicted" pull cases). Used for pull routing (which gatekeeper to try)
    and for the marking walk's remote-known exclusion; grants no reads. A wrong
    or stale claim only misroutes a pull (which fails, and the next recorded
    source is tried) or under-fills the claimant's own packs (its own remote
    then rejects them for missing objects).
  - `pendingPush` — written by the marking walk (below); the read grant for
    queued pushes, keyed to the action so it can be cleaned up.
- **Pull driver** `ensureGitObjects(oids, hints)` in the overseer: look up
  `onRemote ∪ pullableFrom` in `gitObjectMetadata` (trying each recorded
  gatekeeper on failure), mint the gatekeeper stub through the existing
  `getGatekeeperClassFor` chokepoint (so disabled gatekeepers/resources stay
  enforced), call `gitPull(oids, cache, hints)`, verify the requested oids are
  now present. A deleted gatekeeper record → clear error to the agent
  ("reconnect X to pull this commit"). Reachable only from overseer-initiated
  paths — agent-side faults (worktree creation and lazy reads) and the
  `get()`/`buildPack()` pull-through of `pendingPush`-marked objects — so a
  gatekeeper can never direct a pull of anything outside a verified queued push.
- **Lazy walker** (`ensureObject` + hand-rolled parsers, per the locked decision):
  the read-side codec — loose-object header/inflate helpers shared with
  `GitCacheImpl`, plus tree/commit parsers — powering the new lazy read paths.
  `ensureObject(oid, {type, referencedBy})` checks presence, pulls via
  `ensureGitObjects` on a miss (routed by the `pullableFrom` rows that
  `put()`-time referent recording already wrote; `referencedBy` shapes the pull
  hints), then parses. Gadget-history reads never fault (their objects are
  always local) and keep using isomorphic-git untouched.
- **Push authorization at `submitAction`** (resolves the sketch's `pull()` TODO
  by *deleting* it, along with the `GitCache.ensure()` design that briefly
  succeeded it): when an `ActionDescription` carries `pushedCommits`, the
  overseer, before queuing:
  1. **Verifies ancestry.** Every parent chain from each declared head must
     reach a commit `onRemote` for this gatekeeper, walking cached commit
     objects only. An absent ancestor commit is an immediate, agent-visible
     error ("pull the branch history first" / "pull a shared ancestor from the
     destination"), and so is a parentless commit that isn't itself `onRemote` —
     **no vacuous pass for roots**. Pushing derived work back to its origin
     trivially passes (the worktree's base was pulled from there); pushing to a
     *related* remote requires first pulling a shared ancestor commit from it,
     which both proves the repos are related and makes the accidental
     push-to-the-wrong-remote mistake fail closed at queue time. Verification
     never needs ancestors *beyond* the proven commits, so shallow pulls stay
     shallow. The practical v1 bound this implies, stated plainly: the commit
     chain from head to proven ancestor must already be cached, which in
     practice means agent-authored commits atop a destination-proven base.
     Pushing a *pre-existing* branch whose head sits N commits above the shared
     ancestor requires those N commit objects — a history-deepening pull v1
     doesn't offer (deep-history pulls are punted) — so the error message
     should state the limitation plainly rather than send the agent hunting.
  2. **Marks the push closure.** Walks from the heads to the proven ancestors
     and through containment (commit → tree → entries), marking every visited
     object `pendingPush {gatekeeperId, actionId}` — skipping, without
     descending, objects the remote already has (`onRemote ∪ pullableFrom`;
     remotes are closed under containment, so nothing beneath a remote-known
     object needs pushing), and skipping gitlink entries (mode 160000) entirely
     (submodule commits are never part of a push, and following one would mark a
     foreign repo's commit). An absent tree/blob that isn't remote-known is
     still marked; when its bytes later arrive (any `put()`), the mark
     **propagates lazily** to its referents under the same rules and action id.
     Marks land on the metadata rows *and* in a non-unique `pushMarks`
     action-id index, so cleanup and conversion iterate the action's oids
     without re-walking.
- **Mark lifecycle.** Applied successfully → the action's marks convert to
  `onRemote` (the remote provably has them now; they also become re-pullable),
  idempotently and in the same durable step as the queue's completion record, so
  a crash between the push and the conversion strands nothing *locally* — the
  remote side of that same window is the gatekeeper's `applyAction` idempotency
  responsibility (§3/§4). Rejected /
  expired / terminally failed → marks removed via the index. Reverting an
  applied push keeps `onRemote`: the remote genuinely received the objects (the
  ref rolls back; they go dangling), and the gatekeeper already held the pack.
  Gatekeeper-record deletion with pushes still queued cleans up like rejection.
- **`Gatekeeper.applyAction()` gains a `GitCache` parameter.** Approval can happen
  hours after the session that queued the action, so a stub obtained via
  `getGitCache()` at queue time is long gone when the action applies; the overseer
  passes a fresh cache stub with the apply call, scoped to the gatekeeper **and to
  the applying action** — the binding `buildPack()` consumes. The read view is
  unchanged by action scoping (`get`/`has`/`stat` still answer the per-gatekeeper
  `onRemote ∪ pendingPush` union); the action binding only adds `buildPack`.
  Existing gatekeepers simply ignore the extra parameter: the workspace pins
  capnweb-validate 0.3.0, whose Schema Evolution contract explicitly allows this
  — "Extra arguments to a validated method are dropped before it runs" (verified
  against the vendored 0.3.0 README; an implementation declaring fewer parameters
  validates and runs unchanged). The stale pre-0.3.0 comment at
  gatekeeper-email/src/email.ts:592 claimed the opposite and has been corrected
  alongside this plan. The parameter is **required, not optional** (decided): an
  optional `cache?` would only protect the opposite rolling-upgrade direction —
  a new gatekeeper receiving `applyAction(id)` from an older overseer — but all
  gatekeepers deploy together with workshop-backend today, a brief disruption
  mid-rolling-update is acceptable in beta, and the required form keeps the code
  simpler. Revisit if gatekeepers ever version independently.
- **git-store extensions**:
  - Raw object read/write helpers used by the cache impl and walker
    (inflate/deflate + header split), private to git-store + cache.
  - Pack writer for `buildPack`: undeltified entries + SHA-1 trailer, streamed
    over the raw loose objects (deltification/thin packs are future internals).
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
- `ApprovalQueueImpl` (and `SlashCommandAuthorizerImpl`) implement `getGitCache()`;
  the queue's `submitAction` chokepoint runs the `pushedCommits` ancestry
  verification + marking walk, and its rejection/expiry paths run the mark
  cleanup.

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
  - `pinBase` = the commit the chat's current pin is rooted at (initially
    `baseCommit`), advanced **only by epoch resets** — never by explicit commits
    (see the locked decision: the epoch's OT rows compose on it, so moving it
    mid-epoch would double-apply them). After an explicit `commit()`, `headCommit`
    runs ahead of `pinBase` until the next reset. Internal bookkeeping only, never
    surfaced.
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
  since local-origin objects never fault. Then: create the record (pending, like
  `createGadget` — stamped at the step barrier); add the chat binding; record
  `{worktreeId, changeId}` as the tool output so replay never re-creates. For gatekeeper-known commits, creation performs the **initial
  pull**: `gitPull([commit], cache, {type: "commit", commitHistory: {kind: "depth",
  depth: 1}, filterBlobSize: EAGER_BLOB_LIMIT})` — one fetch for commit + all trees
  + small blobs.
- **Pin at birth**: creation declares the pin `{gadgetId: worktreeId, baseCommit}` on
  the same `"changes"` batch that records the creation (which rides the new
  `createdWorktrees` message field — deliberately separate from `createdGadgets` so
  the frontend can't mistake worktrees for gadget creations; see §4), so
  `buildChatContent` reconstruction works from the log alone.
- **File-tool dispatch** — extend the four seams:
  - `resolveWorkpieceRoot`: accept worktree ids for the chat that owns them (other
    chats' worktrees are invisible, like other chats' pending gadgets).
  - Agent tools: worktrees are always pinned, so reads are session-content reads
    (unstamped — the `observedCommit`/elision matrix never applies), and the
    read-before-edit gate works as-is. `writeFile`/`editFile` emit ordinary OT rows.
  - **System prompt: worktrees are never mentioned.** The prompt aims to be
    byte-stable across a chat's turns for prompt caching (the seed binding layer is
    frozen per chat for exactly this reason, agent.ts:1325-1334; mid-chat
    acquisitions are announced via chat history, not the prompt). Since worktrees
    are created mid-chat by the agent itself, the `createWorktree` call and tool
    result in the chat history *are* the announcement; adding a prompt line would
    self-inflict a cache miss on every turn after a creation. Post-compaction,
    knowledge of the worktree rides the handoff summary like every other mid-chat
    acquisition (the checkpoint's `chatBindings` keep the binding functional, and
    `describeBinding`/`listFiles` let the agent re-orient). File lists obviously
    don't belong in the prompt either — discovery goes through the binding API
    (and grep).
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
- **Epoch reset in `mergeChanges`**: after commits land and pins reset, **every**
  live worktree re-pins in the new generation, and the re-pins are recorded on the
  merge message itself (a new `worktreePins` field, §4). The durable record is
  required: the epoch boundary is exactly where pins otherwise evaporate — both
  `buildChatContent` and compaction checkpoints (which clear pins at a boundary)
  must be able to re-establish worktree bases from the log alone. Per worktree: if
  the closed epoch left it dirty (flatten ≠ `pinBase` tree), write an auto-commit
  via `writeChangedFilesAsCommit({treeBase: pinBase, parents: [pinBase]},
  touchedFiles)` — or reuse `headCommit` outright when the flatten equals its tree
  (the agent committed and then made no further edits; no new object needed) — and
  set `pinBase` to it; a clean worktree re-pins at its unchanged `pinBase`.
  `headCommit` is untouched. Worktrees never gate accept (no mainline record, no
  staleness).
- **`Worktree` binding API** (finalize `worktree.d.ts`; the `TODO(now)` file ops):
  - `listFiles(path?, options?: {recursive?: boolean}) → FileMetadata[]` (path +
    file/dir type; **no size** — git tree entries carry mode, name, and oid but no
    blob size, and a filtered pull leaves omitted blobs' sizes unknown until
    fetched, so sizes would force fetching every blob).
  - `readFile(path) → string`, `writeFile(path, text)`, `deleteFile(path)` — text
    oriented; writes/deletes are OT rows exactly like the file tools' (they join
    the same step buffer and land through the same barrier, so replay and the
    UI-someday subscription see them). **`writeFile` on an existing, readable file diffs**: the OT row is a
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
  - `commit(message) → oid` — writes a real git commit capturing the worktree's
    current content. **The new commit's parent is `headCommit`, the last explicit
    commit.** This parent choice is what implements the squash: if accepts have
    advanced `pinBase` through auto-commits since the last explicit commit, those
    auto-commits simply never appear in the new commit's ancestry. The tree is
    built the same way `mergeChanges` builds one — since the current content is by
    definition `pinBase`'s tree with the current epoch's overlay applied,
    `writeChangedFilesAsCommit({treeBase: pinBase, parents: [headCommit]},
    overlayTouchedPaths)` produces it directly, with no diff computation. Then
    **only `headCommit` advances**; `pinBase`, the chat's pin, and the OT rows are
    all untouched, so the rows remain the single record of the overlay and replay
    cannot double-apply it. Right after a commit the content is unchanged and
    `diff()` is empty — exactly git's own behavior after `git commit`. Head
    advancements **ride the step buffer** (plans/step-transactionality.md, a
    prerequisite of this plan): `commit()` writes the git objects eagerly
    (content-addressed and idempotent — a crash orphans them harmlessly) but
    advances only the in-memory head, which later calls in the same execution
    read. The step's persistence barrier then, in the same storage transaction
    that persists the enclosing `executeCode` call's record, advances the
    record's `headCommit` and records the advancements as `worktreeCommits` on
    the step's `"changes"` message (§4) — the durable, sequence-bearing record that revert
    rollback keys on. An advancement is therefore durable iff the call that made
    it is in the transcript: no staging collection, no vouching, and no crash
    window between them. Commit identity comes from the chat owner
    (`commitIdentityForAuthor`). Replay is safe: executeCode results are
    recorded, so the call never re-executes on replay.
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
    base/head SHAs, `getDetails` branch refs). Stamps are pull-routing hints
    only; a gatekeeper *may* also `put()` a commit's bytes alongside an
    observation to upgrade the hint to `onRemote` proof (§1) — not needed for
    the v1 flows, where worktree creation pulls the base.
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
  - Queue: the `ActionDescription` declares `pushedCommits: [commitId]`, and the
    overseer's `submitAction` verification + marking (§1) *is* the validation —
    an unrelated commit, a missing ancestor, or an unproven root fails right
    there, agent-visible, before anything is queued. Description names repo,
    branch, commit, force-ness. Simulation overlays the pending push onto
    `listBranches`/`getCommit` reads per the write-gatekeeper simulation
    convention, reading pending commits via `GitCache.get()` — which serves
    (pulling through if needed) exactly what is queued for push to this remote,
    to be treated as already pushed.
  - Apply: **no gatekeeper-side object walk at all** — call `buildPack()` on the
    action-scoped `GitCache` stub passed to `applyAction()` (approval can happen
    hours after the session that queued the action, so the cache must arrive
    with the apply call — §1/§4) and stream the pack into a send-pack request
    with the ref-update command (`old-sha new-sha refs/heads/branch`, zero-id
    old-sha creates the branch; non-force update requires old-sha match — a
    stale old-sha fails apply with a clear error). The overseer composes the
    pack from the action's pending-push marks, faulting in any absent marked
    objects from their recorded sources — that is the cross-remote
    (pull-from-A-push-to-B) case, batched; a push back to the origin costs
    nothing extra, since the marking walk already excluded everything the remote
    has. An oversized blob in the closure fails a cross-remote push with a clear
    error when the pull-through hits `put()`'s size rejection — accepted for
    now (a same-origin push never meets one: it's remote-known and excluded).
    **Apply is idempotent** (the §4 `applyAction` contract): before sending, the
    DO durably records a per-action intent `{branch, oldSha, newSha}` (it reads
    the branch head to compose old-sha anyway); a retried apply that finds the
    intent recorded and the remote branch already at `newSha` reports success
    instead of failing on a stale old-sha, with `previousSha = intent.oldSha` —
    so revert metadata survives the crash window between GitHub accepting the
    push and the overseer persisting the completion. Record `previousSha` as
    revert info; revert = ref rollback (or delete, if the push created the
    branch); the pushed objects stay `onRemote` (§1).
  - "Create a PR from a commit" = `push` to a branch + the existing
    `createPullRequest` (document the flow in types.d.ts; add a convenience only if
    it earns its keep).

### 4. Shared API finalization (workshop-shared)

- The `gatekeeper.ts` types from 2500f71 land essentially as sketched, with:
  - `GitCache` finalized as `get(oid, hints?)` / `has` / `stat` / `put` /
    `buildPack()` (§1); the sketch's `pull()` TODO resolves by *deletion* —
    gatekeepers never trigger pulls. Doc-comment the scoped view
    (`onRemote ∪ pendingPush`, null otherwise, uniformly across
    `get`/`has`/`stat`), the simulation contract (a pending commit reads as
    already pushed), `buildPack()`'s zero-argument, apply-time-only nature (the
    action-scoped stub supplies the commit list and closure), and the
    parallel-`put` note (no batch method; the stub is facet-to-parent, always
    local).
  - `ActionDescription.pushedCommits?: GitOid[]` — the push declaration
    `submitAction` verifies and marks (§1). Doc-comment the symmetry:
    observations *advertise* commits (`gitCommits` — unproven pull-routing
    hints), actions *declare* pushes (`pushedCommits` — ancestry-checked as a
    mistake-safeguard, and the source of the pending-push view that simulation
    reads).
  - `Gatekeeper.applyAction()` gains a `GitCache` parameter (§1 — the queue-time
    stub is unavailable at apply time; the apply-time stub is action-scoped and
    carries `buildPack`). Its doc-comment also gains the general contract that
    the overseer may deliver the same apply more than once (crash/retry), so
    implementations must be idempotent — formalizing what crash recovery always
    implied. The new push action honors it (§3); auditing existing gatekeepers'
    actions for it is explicitly out of scope here.
  - `GitPullHints.commitHistory` stays **required** — a default would have to be
    either "full" (which we never intend to request) or an arbitrary depth; better
    to make every caller say what it means.
  - Doc comments to the kernel review bar on every export; `@validateRpc()` on the
    implementations (per repo convention — it goes on implementations, not
    interfaces).
- `worktree.d.ts` finalized per §2 (file ops filled in, commit-squash semantics
  documented from the *agent's* point of view — i.e. not documented at all: the API
  simply reports the last explicit commit as HEAD).
- `api.ts` changes are minimal but real (tool calls and chat-log message shapes
  live there):
  - a `createWorktree` `AiToolCall` variant, carrying the recorded
    `{worktreeId, changeId}` output;
  - `createdWorktrees` on `"changes"` messages — separate from `createdGadgets` so
    the frontend never renders a worktree as a gadget creation;
  - `worktreeCommits` on `"changes"` messages — `{worktreeId, commit,
    previousHead}[]`, the durable record of explicit `commit()` head advancements
    (recorded at the step barrier on the step's single `"changes"` message, like
    `createdGadgets` — a step's extras and edits revert together; the revert
    rollback anchor — see the edge case);
  - `worktreePins` on `"merge"` messages — the epoch re-pins (§2), the durable
    record `buildChatContent` and compaction checkpoints re-establish worktree
    bases from.
  Frontend impact is one small diff, not zero: `AiToolCall` is an exhaustive
  union in `ChatInterface.tsx` (`getToolCallSummary`, `describeToolCallCount`,
  `getProvisionalToolVerb` — the last with an explicit `never` check), so the new
  variant needs its rendering cases ("Created worktree …" / "Creating worktree").
  That's desirable anyway: the transcript should show the creation. The new
  message *fields* are ignored by the frontend, and all worktree content is
  stripped from client deliveries (see the delivery-filtering locked decision).

## Constants (tunable, named in one place)

- `EAGER_BLOB_LIMIT` — blob size fetched eagerly at worktree creation (64KB).
- `MAX_WORKTREE_FILE_SIZE` — hard per-file support cap (~1MB; must respect the
  existing `MAX_FILE_TEXT_LENGTH` UTF-16 and 2MB-record constraints).

## Verification spikes (early, cheap, before the transport commits)

1. **GitHub upload-pack capabilities** against a live repo: protocol v2 fetch with
   SHA `want`s for commits *and* blobs, `shallow` combined with `filter`,
   `blob:limit` and `tree:<depth>` support — including the exact-object mappings
   the pull-through defaults depend on (`tree:0` alongside a commit want — also
   the "pull a shared ancestor commit alone" flow; `tree:1` + no-blobs alongside
   a tree want). (Partial-clone lazy fetch implies blob
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
  *new* faults fail, with an actionable error — including a `get()`/`buildPack()`
  pull-through mid-simulation or mid-apply ("reconnect X").
- **Trust model: oids are capabilities, and gatekeepers are trusted with them.**
  The scoped cache view is a mistake-safeguard and a simulation aid, **not a
  confinement boundary** — don't document it as one. Assume a gatekeeper can
  read any object whose oid it knows: for a tree/blob it can fabricate a commit
  naming the oid, parent the fabrication on an `onRemote` commit of its own,
  and declare it in `pushedCommits`; and the shared-ancestry rule is not
  security-grade either — obtaining the *content* of any one commit in a
  history (a root commit may even be guessable) and `put()`ing it makes
  everything chaining onto it pushable to, and hence readable by, that
  gatekeeper. This is consistent with the existing trust model: gatekeepers
  already implement their own pre-approval simulation, and nothing stops one
  from skipping the approval flow entirely — users must not connect a
  gatekeeper they don't trust to a workspace holding sensitive data. Least
  authority still applies (don't widen the view casually), but don't contort
  the implementation chasing stronger properties here, or claim guarantees
  stronger than these.
- **Submodules (gitlink entries) are inert everywhere**: the lazy walker and
  `listFiles` surface them as unsupported entries and never walk through them,
  the marking walk skips them (§1 — following one would mark a foreign repo's
  commit), and pushes never include them. Consistent with the text-only scope.
- **Local-root histories are unpushable by design**: a worktree created from a
  purely local commit (gadget history, another worktree) fails ancestry
  verification against every gatekeeper — nothing in its history is proven on
  any remote, and root commits get no vacuous pass. The queue-time error should
  say so plainly; exporting local work to a fresh repo is the punted,
  explicitly-human flow.
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
  pins ride along unchanged within an epoch. Across an epoch boundary, checkpoints
  clear pins — worktree bases then re-establish from the merge message's
  `worktreePins` (§2/§4), which is why that field is the durable record and not
  just record state. Verify checkpoint `proposedChange` composition handles
  worktree ids (it should — ids are opaque).
- **Chat deletion**: delete worktree records + chat bindings; objects stay (no GC,
  dangling is fine and consistent with gadget history behavior).
- **Turn abort / revert vs. `commit()`**: a `commit()` happens *inside*
  `executeCode`, with no log event of its own, while reverts mark messages, not
  calls. That is why advancements ride the step's `"changes"` message's
  `worktreeCommits` field (§2/§4): the durable record has a chat sequence, like
  pending creations and binding additions. With the step barrier
  (plans/step-transactionality.md) the lifecycle is short:
  - **Revert**: a revert covering a `worktreeCommits`-bearing message rolls each
    affected worktree's `headCommit` back to the earliest reverted advancement's
    `previousHead` (entries are ordered within a message and messages by
    sequence, so multiple commits per step or per reverted range compose).
  - **Turn abort / crash mid-step**: the in-flight step's buffer — edits and
    head advancements alike — simply evaporates; nothing durable exists until
    the barrier. Completed steps' advancements are ordinary message-recorded
    state that abort deliberately keeps (abort stops the agent, it does not
    revert; the user reverts explicitly if they want the work gone).
  - **Accept/merge**: cannot run mid-turn (turns hold the chat), so it never
    observes a mid-step advancement.
  The commit objects themselves always remain — dangling and harmless, like
  auto-commits; a queued push referencing a rolled-back commit's oid stays valid,
  since the object is real. Test: abort after a mid-step commit (buffer dropped,
  `headCommit` unchanged); a user revert spanning a step that committed twice;
  crash-resume mid-step (no durable trace; the re-run's `commit()` parents on
  the unchanged head).
- **Delivery filtering must cover every client path**: live `changeApplied` events,
  subscribe-replay of retained rows, message delivery (`"changes"`/`"merge"`
  payloads and pins), and chat metadata (`codeBase` pins). Miss one and the
  frontend's OT client fetches a repo-sized base commit. Test by subscribing as a
  client to a chat with an active worktree and asserting no worktree id, pin, or
  commit content appears anywhere in the received traffic — and that the revision
  stream stays gapless across stripped rows.
- **`getCodeAtCommit` is client-callable with an arbitrary oid** and materializes
  the full tree server-side; a client that learns a worktree commit id must not be
  able to make the overseer materialize (or fault-pull) a repo-scale tree. Guard
  (locked): it **never faults** — any missing object is an immediate error, which
  pulled repos (filtered, shallow) hit almost immediately — **and** it enforces a
  **hard materialization cap** (total bytes / file count at gadget scale, aligned
  with the existing `MAX_FILE_TEXT_LENGTH`-era limits) for fully-local trees.
  Chosen over restricting to "gadget-history commits" because that has no cheap
  discriminator: a worktree's locally-written commits carry no provenance rows
  either, so classification would need its own bookkeeping while the cap needs
  none.
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

0. **Prerequisite: the step-transactionality refactor**
   (plans/step-transactionality.md) lands first, as its own PR — it fixes a live
   crash bug independently of worktrees, and commits 3–4 assume the per-step
   buffer and transactional barrier it introduces (worktree edits and `commit()`
   head advancements have no crash machinery of their own).
1. **shared: git cache API** (workshop-shared) — finalize changes from 2500f71:
   `gatekeeper.ts` additions (`GitCache` as scoped `get(oid, hints?)`/`has`/
   `stat`/`put`/`buildPack` with the parallel-`put` doc note and the simulation
   contract, `GitPullHints` with `commitHistory` required, `Gatekeeper.gitPull`,
   the `GitCache` parameter on `Gatekeeper.applyAction`,
   `ActionDescription.pushedCommits`, `ObservationAuthorizer.getGitCache`,
   `ObservationDescription.gitCommits`), fully doc-commented. No implementation
   yet; overseer gains a stub `getGitCache` so the tree compiles.
2. **backend: git cache + provenance + push authorization** — `GitCacheImpl`
   (per-gatekeeper stub minting; scoped `get`/`has`/`stat` incl. pending-push
   pull-through with hints; `put()` with proof-of-possession recording;
   `buildPack` over a new undeltified pack writer), `gitObjectMetadata`
   (type/size/`onRemote`/`pullableFrom`/`pendingPush`) + the `pushMarks` action
   index, metadata recording at `authorizeObservation` and `put()` (incl.
   tree/commit referent rows), `submitAction` ancestry verification + marking
   walk + lazy propagation + mark lifecycle (apply-converts / reject-cleans /
   revert-keeps), `ensureGitObjects` pull driver, the lazy walker
   (`ensureObject`, hand-rolled tree/commit parsers over the shared raw codec),
   passing the cache to `applyAction`, git-store extensions (`readFileAtCommit`,
   `listTreeEntries`, `writeChangedFilesAsCommit` with separate
   treeBase/parents, raw object helpers). Workerd tests: cache round-trips vs
   known-good git hashes, poison rejection, metadata at every write point,
   fault-pull-retry with a mock gatekeeper, ancestry verification (proven-base
   pass; absent-ancestor error; root-commit rejection; advertisement alone
   rejected while observation-time `put()` passes), marking-walk matrix
   (remote-known skipped without descent, gitlinks skipped, absent objects
   marked + lazy propagation at `put()`), the `get()`/`has()`/`stat()` view
   matrix (onRemote / pendingPush / other × present / absent, pull-through
   receiving the hints), mark lifecycle
   across apply/reject/revert and a crash between push and conversion,
   `buildPack` completing the closure (absent marked tree faulted → children
   marked and faulted in turn, batched per source; action-scoped stub required,
   session stub throws) with output verified by real `git index-pack` fixtures,
   walker output
   cross-verified against isomorphic-git over the same store, changed-files
   commits reusing subtree oids.
3. **backend: worktree records + createWorktree + file tools** — `GadgetRecord` →
   `WorkpieceRecord` (`type` discriminator, optional `bindingName`, null-index
   opt-out) with the full consumer audit (`subscribeToWorkpieces`,
   `defaultBindingList`, promotion/reconciliation, blueprint enumeration, loader
   paths), api.ts additions (`createWorktree` tool-call variant,
   `createdWorktrees` on changes messages) with the frontend's tool-call
   rendering cases (the exhaustive `AiToolCall` switches in `ChatInterface.tsx`),
   `createWorktree` tool (local + metadata prefix resolution, gatekeeper-free
   commits allowed, initial pull, recorded output, birth pin, pending
   lifecycle), the four dispatch seams, lazy
   content for worktree roots in `buildChatContent`/session content (no
   system-prompt changes — worktrees are announced by their own tool results),
   **client delivery filtering** (rows, replay, messages, metadata;
   revision-preserving). Tests: create/replay determinism,
   create-from-local-commit (no gatekeeper), edit-through-OT on a worktree, lazy
   blob fault, oversize/binary read errors, revert-deletes-worktree, chat-deletion
   cleanup, other-chat invisibility, and the client-subscription leak test (no
   worktree data in any delivered traffic; gapless revisions across stripped
   rows).
4. **backend: epochs + Worktree binding API** — auto-commit + re-pin at
   `mergeChanges` reset (`worktreePins` on the merge message, headCommit reuse
   when trees match, squash semantics), the `Worktree` RpcTarget (listFiles/
   readFile/writeFile/deleteFile/grep/structuredGrep/commit/diff, with
   diff-based `writeFile`), buffered `commit()` head advancements landing as
   `worktreeCommits` on the step barrier's `"changes"` message (in-memory until
   the barrier; §2) + the revert rollback rules, unified-diff formatter,
   `describeBinding` text, finalized `worktree.d.ts`. Tests: accept with dirty
   worktree preserves
   content and squashes (explicit commit parents on last explicit head after N
   accepts, tree built from pinBase + overlay only), commit() leaves pins/rows
   untouched (no double-apply on replay; empty diff right after), boundary re-pin
   replay from `worktreePins` (incl. across a compaction checkpoint), commit
   determinism, `writeFile` emits minimal edits (and `set` for new/unreadable
   files), diff output goldens, grep batch-fill (one pull for a directory of
   missing blobs), abort-after-mid-step-commit (buffer dropped, head unchanged)
   and revert-across-two-commits head rollback, crash-resume mid-step (no
   durable trace; the re-run's commit parents on the unchanged head), multiple
   executeCode calls per turn each advancing the head across separate barriers,
   multiple commits within one step (advancements ordered within the message).
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
7. **github: push + PR-from-commit** — `push` action (queue/simulate/apply/
   revert): `pushedCommits` declaration, simulation overlay reading pending
   commits via `get()`, apply = `buildPack` stream → send-pack framing +
   ref-update command; types.d.ts flow docs for push + createPullRequest.
   Tests: queue-time rejection surfaces to the agent (unrelated commit, missing
   ancestry, unproven root), simulation reads pending commits as pushed,
   ref-update encoding, force/non-force, stale old-sha failure, idempotent
   re-apply (intent recorded, remote already at `newSha` → success with the
   original `previousSha`), revert to `previousSha`, branch-creation push,
   cross-remote push end-to-end against two mock remotes (pull shared ancestor
   from B → push A-derived commits to B, absent filtered blobs pulled through
   during `buildPack`; oversized cross-remote failure).

## Punted / future work (deliberately kept open)

- Worktree UI (changes view, diffs) — the OT stream + pins already carry everything
  a future subscription needs.
- Eviction/GC — `gitObjectMetadata` is the re-pull index; the GC-roots enumeration
  in git-store.ts gains "worktree `headCommit`/`pinBase`/`baseCommit`" when it
  happens.
- Binary and >1MB file editing; `putStream()` for large blobs; cross-remote push
  of trees referencing oversized blobs (the apply-time pull-through hits
  `put()`'s size rejection and fails with a clear error until then — same-origin
  pushes are unaffected, the marking walk excludes them as remote-known).
- Repo initialization / exporting local-root histories to a fresh remote — an
  explicit, human-initiated (likely UI-mediated) act, deliberately unavailable to
  agents and gatekeepers (root commits get no vacuous ancestry pass; see the
  watch-fors).
- `buildPack` internals: deltified/thin packs, and streaming a source
  gatekeeper's pack straight through to the destination without staging every
  object in the cache.
- Cross-chat / workspace-scoped worktrees; user editing of worktrees.
- `merge` / `reset` on the Worktree API.
- Unifying `GatekeeperRecord` into the workpiece table.
- Diff-based `writeFile` for the gadget writeFile agent tool (same helper).
- Deep-history pulls (`commitHistory: full/since` are specified but GitHub-side
  usage ships shallow-only defaults) — also the missing piece for cross-remote
  pushes of *pre-existing* diverged branches (§1's ancestry-verification bound:
  the head-to-ancestor commit chain must be cached).
- Other git hosts (the gatekeeper interface is host-neutral by construction).
