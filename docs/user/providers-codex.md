# Codex profiles

Erebus uses an isolated Codex profile by default. This prevents its app-server, sessions, configuration, plugins, and background work from contending with the Codex desktop app.

## Default profile

Leave **CODEX_HOME path** empty in the Codex provider settings. Erebus resolves it to its managed provider directory, normally:

```text
%USERPROFILE%\.erebus\userdata\providers\codex
```

The development build uses its worktree-local `.t3` state instead. The provider status always shows the effective login command when authentication is missing.

On Windows, the default packaged command is:

```powershell
$env:CODEX_HOME="$env:USERPROFILE\.erebus\userdata\providers\codex"; codex login
```

After login, return to **Settings -> Providers -> Codex** and refresh the provider status.

## Proteus integration

Erebus manages Proteus inside this isolated profile. It ships a tested fallback, checks official stable releases once per day when the Codex environment starts, and accepts an update only after its package digest and runtime layout pass validation. Erebus retains the active and one previous managed runtime and plugin copy. It writes only its owned Codex configuration sections and removes only version directories marked as Erebus-managed. A global Proteus install is not required and does not control the Erebus runtime.

## More than one account

Use **Add Codex account** to add another login. Erebus creates its account profile and keeps `auth.json` separate. Sessions, configuration, skills, plugins, MCPs, and memories continue to use the default Erebus Codex home. On Windows, Erebus uses directory junctions and verified hard links, so this does not require Developer Mode or administrator access.

Sign in from the new account card, then choose which account is **Primary**. Automatic routing prefers that account until its remaining quota reaches the configured switch point. It then sends new turns to a signed-in fallback account. When the primary quota resets, new turns return to it. A running turn stays on its current account; Erebus changes accounts only at a turn boundary and resumes the same Codex task from the shared session store.

The default switch point is 5% remaining. A fallback is preserved at 1% when the primary still has quota. You can change both values or disable automatic routing under **Advanced provider settings**.

Avoid pointing Erebus at the Codex desktop app's main home. Sharing it can mix client versions and saturate or corrupt active app-server work. If you set a custom home, use a directory dedicated to Erebus.

## Feedback to OpenAI

In an existing Codex task, send `/feedback` with an optional description. Erebus asks Codex to upload the relevant task and logs, then shows the returned task ID.
