# Source control

Erebus works with local Git repositories and can connect to GitHub, GitLab, Bitbucket, and Azure DevOps.

## Projects and repositories

Use **Add project** to open a local folder, clone a Git URL, or choose a repository from a connected host. A local repository can be published from the project actions. For an empty repository, Erebus creates the remote and waits for the first commit before pushing.

The project toolbar can initialize Git, open the folder in an editor, create or switch branches, and show the current diff. Each turn also has a hidden checkpoint for review and revert.

## Pull requests

After pushing a branch, create a pull request or merge request from the Git controls. Erebus can draft the title and description from the branch commits.

Linked reviews open in the right panel. You can inspect the diff, edit your own title, description, or comments where the host supports it, open the review in a browser, and link it to the active thread. GitHub, GitLab, and Bitbucket support comment editing. Azure DevOps comments remain read-only.

## Authentication

Authentication belongs to the machine running Erebus.

### GitHub

Install GitHub CLI 2.81.0 or newer, then run:

```sh
gh auth login
```

### GitLab

Install GitLab CLI, then run:

```sh
glab auth login
```

### Bitbucket

Set a Bitbucket access token before starting Erebus.

```powershell
$env:T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

On Linux:

```sh
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

The older `T3CODE_BITBUCKET_EMAIL` and `T3CODE_BITBUCKET_API_TOKEN` pair is also supported. These `T3CODE_*` names remain for compatibility with the upstream codebase.

### Azure DevOps

Install Azure CLI and its DevOps extension, then sign in:

```sh
az extension add --name azure-devops
az login
```

Open **Settings > Source Control** and select **Rescan** after installing a CLI or changing credentials.

## Thread sync is separate

Source control manages the repository you are researching. [Thread history sync](./thread-sync.md) uses its own Git remote to move Erebus conversations between devices. Each connection has separate settings and credentials.
