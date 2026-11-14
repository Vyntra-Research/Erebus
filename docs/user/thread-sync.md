# Thread history sync

Erebus can store portable thread history in a Git repository so the same work can continue on another device. Use the sync control at the bottom of the sidebar.

## What sync includes

The mirror contains primary thread history and attachments for active and settled threads. The following state stays local:

- archived, deleted, and co-agent histories
- Codex accounts and credentials
- provider, model, and permission settings
- wallpapers and other device-local appearance data
- project paths on the current device

Use a private repository when the conversations or attachments are private.

## Connect a repository

Create an empty Git repository, then enter its clone URL under **Git remote**. Choose the branch and fetch interval. Git must already be able to authenticate from the machine running Erebus.

The sync control supports three actions:

- **Check** fetches remote state for comparison.
- **Pull** imports remote changes.
- **Push** writes local changes on top of the newest remote revision.

Erebus reports local and remote changes separately. **Check** compares them, while **Push** publishes local changes.

## Resolve conflicts

Resolve each conflicting thread on its own. You can use the remote history, keep both histories as separate threads, or replace that remote thread with the local history during a push. Replacement stays scoped to the selected thread.

## Link projects on another device

The mirror stores a portable project identity. Each device maps that identity to its own filesystem path through **Optional project links**. An unmatched thread arrives as standalone and can be linked later.

Project links remain local to each device.
