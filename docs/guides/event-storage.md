# Bounded event storage and restart recovery

The default memory store and optional encrypted file store share ordering, terminal-state,
retention and identity rules. Use a dedicated private data directory; journals are runtime data,
not public artifacts. The file profile is for one writer on a local Linux/macOS filesystem, not
shared network storage or distributed execution coordination.

## Configuration

See [runtime-store.example.json](../../deploy/runtime-store.example.json). Provision a 32-byte
random key encoded as standard base64 through your secret manager, under the configured environment
variable name. The configuration contains only the name; no key value belongs in the repository.
The file store refuses to open without the key. Keep that same key for every reopen and backup
restore; key rotation/migration requires an explicit offline procedure and is not automatic.

```bash
export MODEL_RUNTIME_CONFIG=/deployment/runtime-store.json
pnpm dev
```

Containers need a writable private volume at the configured directory even when the root filesystem
is read-only. New directories use mode `0700`, journal files use `0600`; existing unsafe permissions,
symlinks and unexpected ownership are rejected. File lookup accepts UUID execution IDs only.
The repository and container context exclude runtime journals.
The container image prepares `/var/lib/model-runtime` with runtime-user ownership and private
permissions. Mount a new named volume there so Docker initializes those attributes; existing bind
mounts/volumes must be provisioned with matching ownership before launch.

## Persistence boundary

Each journal contains a create record and an append-only sequence of encrypted event records.
AES-256-GCM authenticates every record; its associated data binds it to the format version and
execution ID. The encryption key, original request and raw idempotency key are not journaled.
Idempotency stores only the request fingerprint and key hash, inside encrypted records.

Creation and event appends are published to readers only after file synchronization. Directory
entries are synchronized on creation/deletion. A single-writer lease uses `proper-lockfile` with
fixed heartbeat/stale settings. Lease compromise or write failure closes admission to the store
and wakes subscribers; `/v1/runtime` reports `503` with `state: unavailable`. This is not a
distributed lock or a guarantee against a filesystem that ignores synchronization semantics.

## Recovery and replay

All complete records must authenticate and satisfy sequence/terminal-state checks before any
recovery mutation. Wrong keys, corruption, duplicate identities, unsafe files or unsupported limits
fail startup without echoing record content. Only a final unterminated crash tail is truncated,
after its committed prefix has been authenticated; malformed complete records are never skipped.

Completed executions retain their result and ordered SSE history across reopen. Incomplete
executions receive one terminal `internal_error` with `retryable: false` and an explicit unknown
remote outcome. Recovery never resubmits model work. A same-key request replays the retained
execution; reusing the key with a different request fails.

The store cannot reconstruct missing model-request context or reconnect a provider job. A remote
task may still be running after a process crash. Operators must reconcile that uncertainty before
choosing an explicit new request. Once retention expires or completed history is evicted, both
the execution and its idempotency identity expire; using that key again creates a new execution.

## Resource limits

| Limit | Default |
| --- | --- |
| Runtime active executions | 16 across all providers; additional work is rejected |
| Retained executions | 1000 |
| Logical retained event bytes | 64 MiB |
| Logical bytes per execution | 4 MiB |
| Nonterminal event count per execution | 4096 |
| Terminal retention | 24 hours after the terminal event |
| Encrypted journal disk budget | 256 MiB |

Only terminal records are expired or evicted; active work is never evicted to make room. Retention
policy also pins records while an SSE subscriber is reading, including terminal records; closing
the subscriber releases the pin. Replay consumes any events committed between the list and status
reads before ending, so a concurrent completion cannot hide the final event.
Capacity failure aborts the producer and emits a non-retryable terminal failure using reserved space. The
logical budget permits one extra terminal event of at most 2 KiB per retained execution; the disk
budget reserves up to 4 KiB per execution for its encrypted terminal record. Ciphertext envelopes
and encoding mean disk bytes are not identical to logical event bytes.

The file profile supports at most 8 MiB logical bytes per execution, 8192 events, 10000 executions
and a 1 GiB disk budget, with a 16 MiB physical journal read limit. Configuration beyond that
profile is rejected. Expiration is lazy on store operations; an idle process does not promise a
background deletion deadline. Own backups, encryption-key retention and deletion of backup copies
in deployment policy.

Custom stores can implement `claim`, `lookupIdentity`, `discard`, `available` and `close` in addition
to the base SPI. Atomic claims are required for durable idempotency. `discard` may remove only an
empty entry before any committed event. Call `ModelRuntime.shutdown()` to stop work and drain
subscribers before `ModelRuntime.close()` releases storage ownership. The CLI follows this order.
Custom stores without atomic claims retain a legacy process-local cache capped at 1000 identities;
new keys are rejected when that cache is full rather than silently evicting a still-active identity.
