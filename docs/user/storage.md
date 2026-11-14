# Local storage

Erebus removes a deleted thread only after its provider history is gone. For a standalone thread, deletion also removes the workspace that Erebus created for it. Project folders and active threads are never part of this cleanup.

Finished Codex subagents remain available for seven days, then Erebus removes their local sessions. Settings → Diagnostics shows how much inactive agent history is safe to remove now and offers an immediate cleanup.

Deleting records frees space inside the local database. Settings → Diagnostics → Compact database returns that free space to the operating system. Compaction waits until no turn is active and checks the available disk space before it starts.

The desktop app also clears browser cache from preview partitions that have been inactive for seven days. It keeps cookies and site storage.
