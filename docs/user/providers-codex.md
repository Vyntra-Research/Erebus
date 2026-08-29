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
$env:CODEX_HOME="$env:USERPROFILE\.erebus\userdata\providers\codex"; codex login --device-auth
```

After login, return to **Settings -> Providers -> Codex** and refresh the provider status.

## Proteus integration

Erebus manages Proteus inside this isolated profile. It pins the package version, copies the plugin and skills, writes only its owned Codex configuration sections, and calls the pinned CLI directly. A global Proteus install is not required.

## More than one account

Add another Codex provider only when you need a separate account. Give it a clear display name and a separate **Shadow home path**, authenticate that directory, then refresh its status. Providers can continue the same task only when they share the same main `CODEX_HOME`.

Avoid pointing Erebus at the Codex desktop app's main home. Sharing it can mix client versions and saturate or corrupt active app-server work. If you set a custom home, use a directory dedicated to Erebus.

## Feedback to OpenAI

In an existing Codex task, send `/feedback` with an optional description. Erebus asks Codex to upload the relevant task and logs, then shows the returned task ID.
