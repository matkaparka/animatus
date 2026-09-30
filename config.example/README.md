# Configuration

Copy this directory to `config/` in the repository root (it is git-ignored) and edit the copy.

| File | Purpose |
|---|---|
| `animatus.config.yaml` | Ports, where your own files live, stage defaults, which plugins and modes are enabled, LLM providers and fallback order. Draft: the orchestrator's loader defines the final schema. |
| `.env.example` | Names of the secrets the orchestrator can read. Copy to `config/.env` and fill in values there, or enter them in the console's write-only key page. |

Secrets never go into `animatus.config.yaml`; it refers to them as `${secret:name}`.
Cookies for chat platforms and music services are stored in the Windows Credential Manager (or an
encrypted file), not in `.env`.

`sensitive-words.example.txt` is an empty template for the word list applied before text-to-speech.
The repository ships no default list.
