# Example persona

`persona.md` is a neutral example of the kind of document the orchestrator loads as the character's
system prompt. It is not connected to any real character. To use your own:

1. Copy this folder to `config/persona/` (git-ignored) or any path you point the configuration at.
2. Edit `persona.md`. Keep the output-format section: the sentence splitter and tag parser rely on it.
3. In the console, the persona is read-only for the agent: the agent may only *propose* changes, which
   wait in the approval queue.

Viewer-supplied text never becomes part of the persona.
