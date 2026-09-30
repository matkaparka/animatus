# Safety: what stands between the model and the stream

A live character says whatever the model writes. Several independent layers keep that from going wrong; none of them
trusts the one before it.

| Layer | Where | What it does |
|---|---|---|
| The persona | `personas/<name>/persona.md` | Tells the character what not to do. A model can ignore it, so nothing below relies on it. |
| Cleaning what viewers write | `inbox/text.ts` | Control characters and the program's own markers (`【】`) are taken out of names and messages, so a viewer cannot write a line that looks like the program's. |
| Where a line came from | `tools/origin.ts`, [tools.md](tools.md) | Every reply is judged as its least trusted line; only free tools run for the audience's, and a request for one that needs the streamer's yes is refused before it is listed. |
| The sensitive-word list | `tts/text.ts`, `speech.sensitive_words_file` | Words you name are replaced by a bleep, in the voice and on screen. |
| The last check before the voice | `speech/safety.ts` | What is described below. |
| The streamer's yes | console Approvals tab | Anything that changes the program waits for it. |

## The last check before the voice

It looks at the shape of what is about to be said, not its meaning: it does not know what is sensitive, only what is not
meant to be read out on a stream. It runs on every sentence, whatever its source (a reply to chat, a mode's comment, an
automation's line), before the voice and on the words shown on screen.

**Replaced by the bleep** (the same one the word list uses; `哔` unless `speech.safety.replacement` says otherwise):

| What | Shape |
|---|---|
| a link | starts with `http://`, `https://` or `www.` |
| an email address | `name@host.tld` |
| a long number | nine digits or more, with a single space or hyphen allowed between them (a phone number, a QQ or ID number; a date has eight) |
| a file path | `C:\...`, `C:/...`, or one that starts `/home/`, `/Users/`, `/etc/`, `/var/`, `/usr/`, `/mnt/` |
| a key | `sk-...`, `AIza...`, `ghp_...`, `xoxb-...`, or any run of 32 or more letters, digits, `-` or `_` |

The run log gets one line per sentence saying which classes were replaced (`safety: replaced link, number in a sentence
before it was spoken`), never the thing itself.

**A stuck model:** a sentence said again and again is spoken twice and then not, until something else is said. An alarm
(`speech_loop`) says so while it lasts. Very short interjections (under six letters) are never a loop.

Links and email addresses are kept whole when a reply is cut into sentences: a stop, question mark, exclamation mark or
comma inside `https://example.com/x?a=1` does not end the sentence, and one that ends a chunk right after a link waits for
the next character before it decides. A bare domain without a scheme or `www.` (`example.com`) is not recognised as a link,
by the sentence cutter or by this check.

```yaml
speech:
  safety:
    personal_info: true      # replace what is listed above
    repetition: true         # do not speak a sentence again and again
    replacement: 哔          # plain words: brackets and markdown marks are stripped before speech
```

## What it does not do

It is not a content filter. It does not judge what is said, only what must never be read out. What the character may not
talk about is the persona's business and the word list's; what a viewer may make the program do is the tool gate's. The
text of a reply is kept as the model wrote it in the streamer's own run log and in the chat record under `data/`, which are
private: only what is spoken and shown on the stage is changed.
