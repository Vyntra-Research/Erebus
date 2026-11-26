# Message composer

Messages can contain up to 120,000 characters by default. Under **Settings > Providers > Models**, a model can use a different limit up to 4,000,000 characters. Erebus keeps an oversized draft in the composer and shows how many characters must be removed.

Images upload as soon as you add them. The send button becomes available after each upload finishes. Retry or remove a failed upload. HEIC and HEIF images are converted to JPEG on desktop.

Draft text stays local to the composer while an active turn updates the timeline. Only an explicit send action submits it.

Each prompt reaches the provider with a local send timestamp: weekday, date, time, and UTC offset. The agent can anchor "now" without asking for the clock. The stored message keeps its original text; the timestamp is provider-only.

## Editing a message

Hover a user message and choose **Edit message**. Saving creates a fork of the conversation at that point and sends the edited message in the new thread; the original thread stays unchanged. The fork copies the visible conversation and work history, not the provider session or checkpoints.

## Commands and skills

Type `/` to open commands. Type `$` to search skills. Skill results show their source and add the matching `$name` token to the message.

Turn off **Show skills in slash menu** under **Settings > General** to keep `/` command-only.

From a new thread, press `Ctrl+Enter` to start it in the background and open another draft. The running thread keeps its selected workspace mode and base branch. When **New worktree** is selected, each background thread receives its own worktree.
