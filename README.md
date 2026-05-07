# Ignore Panel

Ignore Panel is a VS Code extension that lists Git ignored files and configured Explorer excludes in a dedicated **Ignored Files** pane inside the Explorer view.

## Preview

<video src="resources/preview.mp4" controls title="Ignore Panel extension preview"></video>

## Features

- Reads Git ignored paths with `git ls-files --others --ignored --exclude-standard --directory`.
- Supports additional ignore files such as `.ignore`, `.npmignore`, `.dockerignore`, `.eslintignore`, `.prettierignore`, and `.vscodeignore`.
- Loads ignored directory contents only when a directory is expanded.
- Can include existing VS Code `files.exclude` patterns in the pane.
- Leaves normal Explorer visibility to VS Code's built-in `files.exclude` and `explorer.excludeGitIgnore` settings.
- Provides refresh, open, and toggle Git ignore hiding commands.

The **Ignored Files** pane can show Git ignored files, enabled `files.exclude` matches, and configured ignore-file sources regardless of whether the normal Explorer currently hides them.

## Settings

- `ignorePanel.includeGitIgnored`: include ignored paths reported by Git.
- `ignorePanel.includeVSCodeExcludes`: include existing `files.exclude` patterns.
- `ignorePanel.extraIgnoreFiles`: extra ignore files to parse.
- `ignorePanel.settingsTarget`: write `explorer.excludeGitIgnore` changes to `workspace` settings or `user` settings. Defaults to `workspace`.
- `ignorePanel.refreshIntervalSeconds`: optional polling refresh interval.

Use VS Code's `files.exclude` setting for Explorer glob excludes. Use VS Code's `explorer.excludeGitIgnore` setting, or the Ignore Panel eye button, to show or hide Git ignored files in the normal Explorer.

## Development

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

Run a syntax check with:

```sh
npm run lint
```

The extension is dependency-free and runs from `src/extension.js`.
