# Local storage

Erebus removes a deleted thread after its provider history is gone. For a standalone thread, deletion also removes the workspace that Erebus created for it. Cleanup protects project folders and active threads.

Finished Codex subagents remain available for seven days, then Erebus removes their local sessions. Settings → Diagnostics shows how much inactive agent history is safe to remove now and offers an immediate cleanup.

Deleting records frees space inside the local database. Settings → Diagnostics → Compact database returns that free space to the operating system. Compaction runs while the task runtime is idle and checks the available disk space before it starts.

The desktop app also clears browser cache from preview partitions that have been inactive for seven days. It keeps cookies and site storage.

Web capture sessions, stored bodies, notes, and scope profiles remain until they are deleted from the Web panel. Managed recon modules keep their active installation and configuration under Erebus application data.

MicroVM disks and configuration remain until the operator or agent removes the VM. Stopping a VM keeps its toolchain and files. Restarting Erebus or the host does not resume guest processes or detached jobs; start the VM again and relaunch the needed work. **Settings → MicroVMs** shows each VM's state and disk use. See [Persistent microVMs](./microvms.md).
