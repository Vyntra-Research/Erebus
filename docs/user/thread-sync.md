# Thread history sync

Erebus can store portable thread history in a Git repository so the same work can continue on another device. Use the sync control at the bottom of the sidebar.

## What sync includes

The mirror contains primary thread history and attachments for active and settled threads. It excludes:

- archived and deleted threads
- co-agent threads and their provider history
- Codex accounts and credentials
- provider, model, and permission settings
- wallpapers and other device-local appearance data
- local project paths

Use a private repository when the conversations or attachments are private.

## Connect a repository

Create an empty Git repository, then enter its clone URL under **Git remote**. Choose the branch and fetch interval. Git must already be able to authenticate from the machine running Erebus.

The sync control supports three actions:

- **Check** fetches the remote state without changing local history.
- **Pull** imports remote changes.
- **Push** writes local changes on top of the newest remote revision.

Erebus reports local and remote changes separately. A successful check does not mean unsaved local threads have already been pushed.

## Resolve conflicts

Resolve each conflicting thread on its own. You can use the remote history, keep both histories as separate threads, or replace that remote thread with the local history during a push. Replacing one remote thread does not force-push the repository.

## Link projects on another device

The mirror stores a portable project identity, not a host filesystem path. If the matching folder exists on the new device, map it from **Optional project links**. A thread without a local match remains standalone and can be linked later.

Linking or moving a thread on one device does not rewrite the project path on another device.
