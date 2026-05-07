'use strict';

const cp = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const vscode = require('vscode');

const VIEW_ID = 'ignorePanel.ignoredFiles';
const LEGACY_EXCLUDE_STATE_KEY = 'ignorePanel.excludeState';
const SETTINGS_TARGETS = {
  user: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace
};

class IgnoredNode {
  constructor({ label, fullPath, relativePath, workspaceFolder, isDirectory, sources, parent, lazyChildren }) {
    this.label = label;
    this.fullPath = fullPath;
    this.relativePath = relativePath;
    this.workspaceFolder = workspaceFolder;
    this.isDirectory = isDirectory;
    this.sources = sources || [];
    this.parent = parent;
    this.lazyChildren = lazyChildren || false;
    this.childrenLoaded = false;
    this.children = [];
  }
}

class IgnoredFilesProvider {
  constructor(context) {
    this.context = context;
    this.nodesByWorkspace = [];
    this.itemById = new Map();
    this.refreshTimer = undefined;
    this.fileWatcher = undefined;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  async start() {
    this.recreateWatchers();
    this.configureRefreshTimer();
    await this.refresh();
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
    this.fileWatcher?.dispose();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  getTreeItem(node) {
    const collapsible = node.isDirectory && (node.lazyChildren || node.children.length > 0)
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = `${node.workspaceFolder?.uri.fsPath || 'workspace'}:${node.relativePath || node.label}`;
    item.resourceUri = vscode.Uri.file(node.fullPath);
    item.description = node.sources.join(', ');
    item.tooltip = `${node.relativePath || node.label}\nSources: ${node.sources.join(', ')}`;
    item.contextValue = node.isDirectory ? 'ignoredFolder' : 'ignoredFile';
    item.iconPath = node.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;

    if (!node.isDirectory) {
      item.command = {
        command: 'ignorePanel.openItem',
        title: 'Open',
        arguments: [node]
      };
    }

    this.itemById.set(item.id, node);
    return item;
  }

  async getChildren(node) {
    if (node) {
      if (node.lazyChildren && !node.childrenLoaded) {
        await loadDirectoryChildren(node);
      }
      return node.children;
    }

    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }

    return this.nodesByWorkspace;
  }

  async refresh() {
    this.itemById.clear();
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const roots = [];

    for (const folder of workspaceFolders) {
      const nodes = await collectIgnoredItems(folder);
      roots.push(createWorkspaceNode(folder, nodes));
    }

    this.nodesByWorkspace = roots;
    this._onDidChangeTreeData.fire();
  }

  configureRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    const seconds = vscode.workspace.getConfiguration('ignorePanel').get('refreshIntervalSeconds', 0);
    if (seconds > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), seconds * 1000);
    }
  }

  recreateWatchers() {
    this.fileWatcher?.dispose();
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/{.gitignore,.ignore,.npmignore,.dockerignore,.eslintignore,.prettierignore}');

    const refresh = debounce(() => this.refresh(), 300);
    this.fileWatcher.onDidCreate(refresh);
    this.fileWatcher.onDidChange(refresh);
    this.fileWatcher.onDidDelete(refresh);
    this.context.subscriptions.push(this.fileWatcher);
  }
}

async function collectIgnoredItems(workspaceFolder) {
  const config = vscode.workspace.getConfiguration('ignorePanel', workspaceFolder.uri);
  const collected = new Map();

  if (config.get('includeGitIgnored', true)) {
    const gitItems = await collectGitIgnored(workspaceFolder.uri.fsPath);
    for (const item of gitItems) {
      upsertCollected(collected, item.relativePath, item.isDirectory, 'git');
    }
  }

  const patternSources = [];

  for (const ignoreFile of config.get('extraIgnoreFiles', [])) {
    const ignorePatterns = await readIgnoreFilePatterns(workspaceFolder.uri.fsPath, ignoreFile);
    for (const pattern of ignorePatterns) {
      patternSources.push({ pattern, source: ignoreFile });
    }
  }

  if (config.get('includeVSCodeExcludes', true)) {
    const excludes = vscode.workspace.getConfiguration('files', workspaceFolder.uri).get('exclude', {});
    for (const [pattern, enabled] of Object.entries(excludes)) {
      if (enabled === true) {
        patternSources.push({ pattern, source: 'files.exclude' });
      }
    }
  }

  if (patternSources.length > 0) {
    const patternItems = await collectPatternIgnored(workspaceFolder.uri.fsPath, patternSources);
    for (const item of patternItems) {
      upsertCollected(collected, item.relativePath, item.isDirectory, item.source);
    }
  }

  return Array.from(collected.values())
    .filter(item => item.relativePath && item.relativePath !== '.')
    .sort(comparePaths);
}

function upsertCollected(collected, relativePath, isDirectory, source) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return;
  }

  const existing = collected.get(normalized);
  if (existing) {
    existing.isDirectory = existing.isDirectory || isDirectory;
    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
    return;
  }

  collected.set(normalized, {
    relativePath: normalized,
    isDirectory,
    sources: [source]
  });
}

async function collectGitIgnored(cwd) {
  const output = await execFile('git', ['-C', cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (!output) {
    return [];
  }

  return output
    .split('\0')
    .filter(Boolean)
    .map(entry => ({
      relativePath: normalizeRelativePath(entry),
      isDirectory: entry.endsWith('/')
    }));
}

function execFile(file, args) {
  return new Promise(resolve => {
    cp.execFile(file, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(stdout);
    });
  });
}

async function readIgnoreFilePatterns(workspacePath, ignoreFile) {
  try {
    const absolutePath = path.join(workspacePath, ignoreFile);
    const content = await fs.readFile(absolutePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
  } catch {
    return [];
  }
}

async function collectPatternIgnored(workspacePath, patternSources) {
  const matchers = patternSources.map(({ pattern, source }) => ({
    source,
    matches: createGlobMatcher(pattern)
  }));

  const results = [];
  await walkWorkspace(workspacePath, async (fullPath, relativePath, isDirectory) => {
    const normalized = normalizeRelativePath(relativePath);
    for (const matcher of matchers) {
      if (matcher.matches(normalized, isDirectory)) {
        results.push({ relativePath: normalized, isDirectory, source: matcher.source });
        return !isDirectory;
      }
    }

    return true;
  });

  return results;
}

async function walkWorkspace(rootPath, visitor, baseRelativePath = '') {
  async function walk(currentPath, relativePath) {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const shouldDescend = await visitor(fullPath, childRelativePath, entry.isDirectory());

      if (entry.isDirectory() && shouldDescend !== false) {
        await walk(fullPath, childRelativePath);
      }
    }
  }

  await walk(rootPath, baseRelativePath);
}

function createGlobMatcher(pattern) {
  const normalized = normalizeRelativePath(pattern).replace(/^\//, '');
  const directoryOnly = normalized.endsWith('/');
  const sourcePattern = directoryOnly ? normalized.slice(0, -1) : normalized;
  const patternWithScope = sourcePattern.includes('/') ? sourcePattern : `**/${sourcePattern}`;
  const regex = globToRegExp(patternWithScope);

  return (relativePath, isDirectory) => {
    if (directoryOnly && !isDirectory) {
      return false;
    }

    return regex.test(relativePath) || regex.test(`${relativePath}/`);
  };
}

function globToRegExp(glob) {
  let expression = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];

    if (char === '*' && next === '*') {
      const after = glob[index + 2];
      if (after === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else if ('\\^$+?.()|{}[]'.includes(char)) {
      expression += `\\${char}`;
    } else {
      expression += char;
    }
  }

  expression += '$';
  return new RegExp(expression);
}

function createWorkspaceNode(workspaceFolder, ignoredItems) {
  const root = new IgnoredNode({
    label: workspaceFolder.name,
    fullPath: workspaceFolder.uri.fsPath,
    relativePath: '',
    workspaceFolder,
    isDirectory: true,
    sources: [`${ignoredItems.length} ignored`]
  });

  const byPath = new Map([['', root]]);

  for (const ignoredItem of ignoredItems) {
    const parts = ignoredItem.relativePath.split('/');
    let parent = root;
    let currentRelativePath = '';

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      currentRelativePath = currentRelativePath ? `${currentRelativePath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      let node = byPath.get(currentRelativePath);

      if (!node) {
        node = new IgnoredNode({
          label: part,
          fullPath: path.join(workspaceFolder.uri.fsPath, currentRelativePath),
          relativePath: currentRelativePath,
          workspaceFolder,
          isDirectory: !isLeaf || ignoredItem.isDirectory,
          sources: isLeaf ? ignoredItem.sources : [],
          lazyChildren: isLeaf && ignoredItem.isDirectory,
          parent
        });
        byPath.set(currentRelativePath, node);
        parent.children.push(node);
      }

      if (isLeaf) {
        node.isDirectory = ignoredItem.isDirectory;
        node.sources = ignoredItem.sources;
        node.lazyChildren = ignoredItem.isDirectory;
      }

      parent = node;
    }
  }

  sortNodes(root);
  return root;
}

async function loadDirectoryChildren(node) {
  node.childrenLoaded = true;

  let entries;
  try {
    entries = await fs.readdir(node.fullPath, { withFileTypes: true });
  } catch {
    return;
  }

  const existingPaths = new Set(node.children.map(child => child.relativePath));
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }

    const relativePath = node.relativePath ? `${node.relativePath}/${entry.name}` : entry.name;
    if (existingPaths.has(relativePath)) {
      continue;
    }

    node.children.push(new IgnoredNode({
      label: entry.name,
      fullPath: path.join(node.fullPath, entry.name),
      relativePath,
      workspaceFolder: node.workspaceFolder,
      isDirectory: entry.isDirectory(),
      sources: node.sources,
      parent: node,
      lazyChildren: entry.isDirectory()
    }));
  }

  sortNodes(node);
}

function sortNodes(node) {
  node.children.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });

  for (const child of node.children) {
    sortNodes(child);
  }
}

function restoreExcludeValues(excludes, entries) {
  for (const [key, previousValue] of Object.entries(entries)) {
    if (previousValue === null) {
      delete excludes[key];
    } else {
      excludes[key] = previousValue;
    }
  }
}

async function cleanupLegacyExplorerHiding(context) {
  const excludeState = context.workspaceState.get(LEGACY_EXCLUDE_STATE_KEY, {});
  if (Object.keys(excludeState).length === 0) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length === 0) {
    return;
  }

  const remainingState = { ...excludeState };
  for (const folder of workspaceFolders) {
    const folderKey = folder.uri.toString();
    const legacyState = remainingState[folderKey];
    if (!legacyState) {
      continue;
    }

    const { entries, target } = normalizeLegacyExcludeState(legacyState);
    if (Object.keys(entries).length > 0) {
      await restoreExcludeEntries(folder, entries, target);
    }
    delete remainingState[folderKey];
  }

  await context.workspaceState.update(
    LEGACY_EXCLUDE_STATE_KEY,
    Object.keys(remainingState).length > 0 ? remainingState : undefined
  );
}

function normalizeLegacyExcludeState(state) {
  if (state.entries) {
    return {
      entries: state.entries,
      target: normalizeLegacySettingsTarget(state.target)
    };
  }

  return {
    entries: state,
    target: vscode.ConfigurationTarget.WorkspaceFolder
  };
}

function normalizeLegacySettingsTarget(target) {
  if (
    target === vscode.ConfigurationTarget.Global ||
    target === vscode.ConfigurationTarget.Workspace ||
    target === vscode.ConfigurationTarget.WorkspaceFolder
  ) {
    return target;
  }

  return vscode.ConfigurationTarget.WorkspaceFolder;
}

async function restoreExcludeEntries(workspaceFolder, entries, target) {
  const config = vscode.workspace.getConfiguration('files', workspaceFolder.uri);
  const currentExclude = { ...getExcludeForTarget(config, target) };
  const nextExclude = { ...currentExclude };

  restoreExcludeValues(nextExclude, entries);

  if (JSON.stringify(currentExclude) !== JSON.stringify(nextExclude)) {
    await config.update('exclude', nextExclude, target);
  }
}

function getExcludeForTarget(config, target) {
  const inspected = config.inspect('exclude');
  if (target === vscode.ConfigurationTarget.Global) {
    return inspected?.globalValue || {};
  }

  if (target === vscode.ConfigurationTarget.Workspace) {
    return inspected?.workspaceValue || {};
  }

  if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
    return inspected?.workspaceFolderValue || {};
  }

  return config.get('exclude', {});
}

function normalizeRelativePath(relativePath) {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .replace(/^\.\//, '');
}

function comparePaths(left, right) {
  return left.relativePath.localeCompare(right.relativePath);
}

function debounce(callback, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

async function openItem(node) {
  if (!node || node.isDirectory) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.fullPath));
  await vscode.window.showTextDocument(document, { preview: true });
}

async function toggleHiding(provider) {
  const config = vscode.workspace.getConfiguration('explorer');
  const current = config.get('excludeGitIgnore', false);
  await setHiding(provider, !current);
}

async function setHiding(provider, enabled) {
  const config = vscode.workspace.getConfiguration('explorer');
  await config.update('excludeGitIgnore', enabled, getSettingsTarget());
  await provider.refresh();
}

function getSettingsTarget() {
  const configuredTarget = vscode.workspace.getConfiguration('ignorePanel').get('settingsTarget', 'workspace');
  if (configuredTarget === 'user') {
    return SETTINGS_TARGETS.user;
  }

  return SETTINGS_TARGETS.workspace;
}

async function activate(context) {
  const provider = new IgnoredFilesProvider(context);
  context.subscriptions.push(provider);
  await cleanupLegacyExplorerHiding(context);

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('ignorePanel.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('ignorePanel.openItem', openItem),
    vscode.commands.registerCommand('ignorePanel.toggleHiding', () => toggleHiding(provider)),
    vscode.commands.registerCommand('ignorePanel.enableHiding', () => setHiding(provider, true)),
    vscode.commands.registerCommand('ignorePanel.disableHiding', () => setHiding(provider, false)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('ignorePanel')) {
        provider.configureRefreshTimer();
        provider.refresh();
      }

      if (event.affectsConfiguration('files.exclude')) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );

  await provider.start();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
