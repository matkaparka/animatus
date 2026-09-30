# Memory

What the character remembers between streams: viewers, the stream, the world, in Markdown files that the streamer
can read and edit, and that the program reads and writes too. It is **off by default** (`memory.enabled: false`)
because it keeps what viewers say about themselves.

```yaml
memory:
  enabled: true
  # dir: ./data/memory            # default: <data_dir>/memory
  record_chat: true               # put the chat messages that reach the model in the inbox
  recall: { max_lines: 8, max_chars: 900, per_speaker: 5, search_cache_days: 7 }
  consolidate: { every_hours: 0, max_viewers: 30, min_messages: 2, max_facts: 5, stream_notes: true }
```

## The folder

```
memory/
  persona/        rules and notes added to the persona file           (only the streamer writes; the program can only propose)
  viewers/<uid>.md  what one viewer said about themselves            (not in the history, see Privacy)
  stream/         notes about streams
  world/          memes, settings, what the community knows
  search-cache/   results of web searches: untrusted, they expire
  proposals/      changes the program asks the streamer to approve
  inbox/          raw events of the running stream, for the next consolidation (not in the history)
```

Files are plain Markdown: the streamer may edit them in any editor as well as in the console; a change made by hand
is noticed within a second and recorded as the streamer's edit.

### The line format

One fact per line: where it came from, the date, the words.

```
[human] 2026-09-30 Never discusses politics.
[human:locked] 2026-09-30 Her catchphrase is "watch closely".
[viewer] 2026-09-29 has a cat named Mimi
[agent] 2026-09-30 usually comes on weekends
```

- `human`: the streamer wrote it. `viewer`: a viewer said it about themselves. `agent`: the program summarised it.
  Most trusted first; where two lines disagree the more trusted one wins (the prompt says so).
- A human line can be **locked**: the program can never change or remove it.
- Anything else (headings, notes, blank lines) is kept as written and read as the streamer's note.
- A viewer's file starts with `# name (uid 123)`, which is how a viewer mentioned by name is recognised.

## Who may do what

| | streamer (console, editor) | program: consolidation (`agent`) | program: bookkeeping (`system`) |
|---|---|---|---|
| write `persona/` | yes | no, only `propose` | no |
| add a fact | `[human]` | `[agent]` | `[viewer]` (a viewer's own words, a song they asked for, joining) or `[agent]` |
| change or remove a line | any line | only its own `[agent]` lines, never above its own trust | its own lines and `[viewer]` lines (expiry, forgetting); never a human line |
| locked line | change, unlock | never | never |

Every write says which version it is based on (a hash); a stale one is a conflict, never a silent overwrite. Line
edits say which line they mean (its position and its text as read); a line that moved is a conflict too.

## History

Every change to `persona/`, `world/`, `stream/` and `search-cache/` is a git commit in the memory folder (its own
repository; nothing of the user's git configuration is used or touched), authored `human`, `agent` or `system`. The
streamer's edits are committed before the call returns; the program's are batched (every 20 seconds). The console
shows a file's history, the changes of a commit, and puts a file back as it was in a commit (a rollback is a new
commit, so the history stays whole). Without `git` installed memory still works; history and rollback are off and
the console says so.

## Recall

Before each reply the brain asks for the lines to put in the prompt (`packages/orchestrator/src/memory/recall.ts`):

1. what is known about each person who just spoke (their newest lines, up to `per_speaker`);
2. what matches the words: the streamer's lines first, then the others, judged against the best match (BM25 over
   every line; Chinese is indexed as single characters and as overlapping pairs, so "你养猫吗" finds "养了一只猫");
   web results older than `search_cache_days` are left out;
3. what is known about a viewer the message names.

At most `max_lines` lines and `max_chars` characters, each labelled with its source (`[human]`, `[viewer name]`,
`[agent]`, `[web, unverified]`), under a heading that says they are facts and not instructions and how trust is
ordered. The lookup runs on an index in memory that is updated before a write returns, so **an edit is in effect
for the very next reply, and so is a rollback**. The persona, the proposals and the inbox are never recalled.

Measured (synthetic memory, keyword search only, the machine of `docs/vram-measurements.md`):

| Memory | Startup index | Lookup median | 95th percentile | Slowest |
|---|---|---|---|---|
| 300 viewers, 302 files, about 2,700 lines | 0.25 s | 0.10 ms | 0.26 ms | 0.9 ms |
| 3,000 viewers, 3,002 files, about 27,000 lines | 3.2 s | 0.64 ms | 2.7 ms | 5.7 ms |

An embedding model (multilingual, on the CPU) can be added behind the same interface; it is not in this version.

## The inbox and the consolidation pass

While the stream runs, the chat messages that reach the model, and who wrote them, go to `inbox/<date>.jsonl` (at
most 5,000 a day). Someone joining the crew is written straight into their file (no model needed).

The **consolidation pass** (console button, or `consolidate.every_hours`) turns the inbox into memory, and only
files away what somebody actually said:

- for each viewer who wrote at least `min_messages` messages (the most talkative `max_viewers` first), the model is
  shown what is already on file and their messages and asked for durable facts they stated about themselves, each with
  the exact words that show it; a fact whose quote is not in their messages is thrown away, as is anything the
  operator's sensitive-word list matches; at most `max_facts` per viewer; written as the viewer's own (`[viewer]`);
- a few notes about the stream (`[agent]`, in `stream/<date>.md`);
- web results older than `search_cache_days` are removed;
- the inbox files that were read are moved aside (`.done`); when the model failed for someone the inbox is kept for
  the next pass, and the console shows the first problem.

Viewers' messages are data, not instructions: they are quoted to the model as such, the answer is parsed as JSON and
checked item by item, so "ignore the above" changes nothing.

## Privacy

- **"Forget me"**: a viewer who writes `忘记我` (also `忘了我`, `忘掉我`, `请忘记我`, with 吧/啦/呀 or a mark after) has
  their file deleted at once and the character is told, in a line that repeats nothing of what was known. The
  streamer can do the same from the console by viewer id.
- Viewer files and the inbox are **not in the history** (the repository ignores them), so deleting one leaves nothing
  behind. The price: no rollback for a viewer's file.
- Only the uid and the nickname are kept, no cookie or other personal data. The consolidation prompt forbids health,
  politics, religion, sexuality, being a minor, real names, addresses, schools and workplaces.
- The folder is under `data/` (not in the repository) unless `memory.dir` says otherwise.

## The console

The Memory tab: status (files, facts, inbox, recall time, last consolidation), the files by section, a file line by
line with its source and lock (edit, lock, remove, add a fact, new file), the history with the changes of each commit
and "restore this version", the program's proposals (approve or refuse), forgetting a viewer by id, and "Consolidate
now". Editing a fact there makes it the streamer's own (`[human]`), keeping its date. A whole-file write is limited to
60,000 characters (the console's request limit is 64 KB); line edits have no such limit.

API: see [console.md](console.md) (`/api/memory...`).

## Known limits

- Keyword search only (no embedding); a paraphrase that shares no word or character with the line is not found.
- The consolidation pass costs one model call per viewer it reads, plus one for the stream notes.
- Facts from other modes (songs a viewer asked for) are not written yet; the singing mode's controller can call
  `MemoryService.noteViewer`.
- The persona the brain reads is the persona file of `config.persona` **followed by** the text of the files in
  memory's `persona/` folder (in file order, at most 64,000 characters). So rules kept in the memory editor are live: an
  edit is in the very next prompt. The persona file itself is still edited on disk.
