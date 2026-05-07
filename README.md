# Ignore Panel

Ignore Panel is a VS Code extension that keeps ignored files and folders out of the normal Explorer and lists them in a dedicated **Ignored Files** pane inside the Explorer view.

## Features

- Reads Git ignored paths with `git ls-files --others --ignored --exclude-standard --directory`.
- Supports additional ignore files such as `.ignore`, `.npmignore`, `.dockerignore`, `.eslintignore`, and `.prettierignore`.
- Loads ignored directory contents only when a directory is expanded.
- Can include existing VS Code `files.exclude` patterns in the pane.
- Writes workspace-scoped `files.exclude` entries so ignored paths disappear from the normal Explorer.
- Provides refresh, open, reveal, and toggle-hiding commands.

## Settings

- `ignorePanel.hideIgnoredFiles`: hide discovered ignored paths in the normal Explorer.
- `ignorePanel.includeGitIgnored`: include ignored paths reported by Git.
- `ignorePanel.includeVSCodeExcludes`: include existing `files.exclude` patterns.
- `ignorePanel.extraIgnoreFiles`: extra ignore files to parse.
- `ignorePanel.extraExcludeGlobs`: extra workspace-relative glob patterns.
- `ignorePanel.refreshIntervalSeconds`: optional polling refresh interval.

## Development

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

Run a syntax check with:

```sh
npm run lint
```

The extension is dependency-free and runs from `src/extension.js`.
