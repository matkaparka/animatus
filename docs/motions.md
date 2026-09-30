# Motions

Body motions are your files: the program ships none. Point `paths.motions` at a folder and the program plays what it finds
there. Without one the character has a built-in relaxed pose, breathing, blinking, gaze and small head movements, which is
enough to talk.

## The folder

```
<paths.motions>/
  idle_loop.vrma            the base pose while nothing happens (optional)
  idle/*.vrma               other idle poses, rotated every few minutes (optional)
  talk/*.vrma               clips played while the character speaks
  poses/<tag>.vrma          a one-shot motion the model can ask for by name
  poses/<tag>_2.vrma        more variants of the same tag (_3, _4, ...)
  dance/<name>/motion.vrma  a dance, with music.ogg|mp3|wav and meta.json beside it (see modes.md)
```

Anything else in the folder is ignored. Files are VRM Animation (`.vrma`) and nothing else. A missing sub-folder is
just empty; a `paths.motions` that does not exist is an alarm on the Run page. A file whose name is not safe to serve
is left out. The layout is the one the previous setup used, so its folder can be pointed at as it is.

## What each is for

- **Idle.** `idle_loop.vrma` is the base pose the character comes back to; the files in `idle/` are other resting poses
  it drifts to every few minutes while idle. Before speaking or making a gesture it returns to the base pose first, so
  a folded-arms pose never blends into a gesture. With no `idle_loop.vrma` the built-in relaxed pose is the base.
- **Talk.** While the voice is sounding the character plays talk clips in a shuffled order, cross-fading between them,
  and settles back to idle a moment after the sound stops. Every clip is also played mirrored (left and right swapped),
  so two clips make four.
- **Poses.** The model asks for a pose by writing `[motion:nod]` at the start of a sentence. The program puts the list of
  tags it has into the model's prompt by itself, so the model only asks for what exists; a tag that is not in the list
  is dropped. With several variants of a tag one is picked at random, never the same as the last time.
- **Dances.** See [modes.md](modes.md#dance).

## Making clips that fit

- The loader handles the difference between VRM 0 and VRM 1 models, so one clip serves both.
- Tracks for the eyes and the jaw are ignored on purpose: gaze belongs to the program's own layer and the mouth to lip
  sync. Expression tracks in a clip are played.
- The clip is applied to the model's normalised bones, so it fits bodies of different proportions, but it does not know
  the body: an arm swing that clears one chest can pass through another. Look at a clip on your model before you
  stream it.

## Changes while the program runs

Idle, talk and pose files are read when the program starts and sent to the stage then: restart to pick up a change.
Dances are looked up when one is asked for, and the folder is rescanned at most every 15 seconds, so a new dance is
found without a restart. The start-up log says what was found: `motion library: N talk, M tags, K dances`.
