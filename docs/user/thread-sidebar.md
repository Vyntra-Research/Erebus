# Organizing threads

Threads do not need a project. The main **New thread** action creates a standalone thread. Shift-click it to create the thread in the current project, or use the new-thread action beside a project name.

A standalone thread appears under **Threads**. Link it later from its context menu with **Add to project**, or drag it into a project folder. A linked thread can move to another project through the same menu. The project supplies the workspace path; the conversation history stays with the thread.

Projects are local folders. Adding or removing one from the sidebar does not delete its repository.

## Active, settled, and archived

Settle work that should remain visible but no longer needs attention. Un-settling returns it to the active list without changing its timestamps. Erebus can settle a thread after its linked pull request merges or after the configured idle period.

Archive a thread when it should leave the normal sidebar. Deleting a thread removes its Erebus history and cannot be undone.

Pin a thread to keep it above other work. Drag pinned threads to change their order.

## Co-agent threads

Co-agents appear beneath their parent while they work. Releasing or deleting a co-agent removes its stored Codex conversation and the history of native subagents it started. Collect the handback first. The parent and other threads remain intact.

Standalone threads can create co-agents without a project. Their child workspaces remain isolated from unrelated standalone threads.

## Pull requests and titles

Link a pull request from its thread action so its state appears in the sidebar. Erebus can settle the thread when that pull request merges. Remove the link from the same action when it no longer belongs to the thread.

Use **Regenerate title** in the thread menu to create a new title from the conversation.

## Git sync

The sync control at the bottom of the sidebar can move thread history between Erebus installations. Project folders are never copied. See [Thread history sync](./thread-sync.md).
