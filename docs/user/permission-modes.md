# Permission modes

A permission mode controls when Codex stops for approval. Set it per thread from the composer. A co-agent inherits the parent thread's mode; otherwise a new thread starts in **Full access** unless you choose another mode before sending.

## Modes

**Supervised** asks before commands and file changes. Work outside the workspace stays restricted.

**Auto-accept edits** accepts file changes and asks before commands or other actions.

**Auto** lets Codex review routine actions and pauses on actions that still require approval.

**Full access** runs commands and edits directly. Erebus still applies its deterministic command guard and blocks hard safety violations before execution.

Approvals appear inside the conversation. Approve or reject one and the turn continues from that point.

Use Full access in a workspace you trust. Use Supervised when an unwanted command would be expensive or when you are testing unfamiliar behavior. Auto-accept edits is useful when file changes are expected but shell commands still need review.
