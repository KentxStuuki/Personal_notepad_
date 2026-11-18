# Notiq

Notiq is a name inspired by the combination of "Notepad" and "IQ." The word Not comes from Notepad, representing simplicity, writing, and capturing thoughts, while IQ represents intelligence, ideas, and a smarter way of organizing information.

A lightweight, fully offline desktop notepad built with Electron, plain HTML, CSS, JavaScript, and Node.js. Notiq is designed to provide a clean, distraction-free writing experience while bringing essential productivity features into one organized workspace.

It combines a minimal text editor with a workspace explorer, tabbed editing, automatic saving, built-in search, Markdown formatting, and drag-and-drop functionality. Whether you're jotting down quick notes, organizing ideas, drafting documents, or managing multiple text files, Notiq keeps everything accessible in a simple and familiar environment.

## Commands

```bash
cd Notiq
npm install            # once; downloads Electron
npm start              # run in development
npm run pack           # unpacked build (quick packaging test)
npm run dist           # Windows installer + portable exe in dist/
npm run measure        # Linux-only performance harness (needs Xvfb), see "Performance"
```

## Features

**Workspace and files** - open a folder (or drop one on the window), lazy-loaded tree, create/rename/delete files and folders, inline naming,
context menus, `F2` / `Delete`, resizable and collapsible sidebar. Deleting moves items to the trash after a native confirmation.

**Tabs and saving** - one editor per tab (own undo history), unsaved dot, no duplicate tabs, save/discard/cancel prompts, manual and
debounced auto-save, atomic writes, external-change detection (asks before overwriting), UTF-8 BOM and CRLF preserved.

**Drag and drop**
- *From Windows Explorer:* drop `.txt` / `.md` files to open them (already-open files just activate their tab). Drop a folder to make it the
  workspace. Nothing is copied, moved or modified. Unsupported items are skipped with a message. A full-window overlay shows while dragging.
- *Inside the explorer:* drag files or folders onto a folder (or onto empty space for the workspace root). Valid targets get a dashed accent
  outline, invalid ones a red outline and a "not allowed" cursor; hovering a collapsed folder for 0.7 s expands it. A folder cannot be dropped
  into itself or its descendants, and a move is **refused (never overwritten)** when the destination already has an item with that name - you
  are told, and nothing changes. Open tabs follow moved/renamed files.

**Search** (`Ctrl+F` document, `Ctrl+Shift+F` workspace, or the toolbar / explorer buttons; scope switch inside the panel)
- *Document:* all matches are highlighted, current match emphasised, "n of N" counter, Enter / Shift+Enter (or the arrows) to move, match-case toggle, clear button, `Esc` closes. The document is never modified.
- *Workspace:* searches the contents of `.txt` / `.md` files, runs in the main process asynchronously (results stream in; a new search cancels the old one), shows file name, relative folder, line number, a preview with the keyword highlighted, totals (matches and files). Clicking a result opens the file (or activates its existing tab) and selects the match. Dot-folders, `node_modules`, binary and unreadable files are skipped; limits: 5 MB per file, 50 listed matches per file, 2000 listed matches overall (totals are still counted per file).
- Results reflect the **saved** contents on disk. If you edited a file since, the match is relocated in the open document when possible.
- Match highlighting is drawn for documents up to 300,000 characters; larger documents still get selection and counts.

**Formatting toolbar** (Markdown source stays the source of truth - nothing is converted to HTML or replaces your text)

| Style | Markdown written |
|---|---|
| Title | `# ` (the first `# ` heading of the document) |
| Subtitle | `## ` directly after the title |
| Heading 1 / 2 / 3 | `# ` / `## ` / `### ` |
| Section | `#### ` (rendered as an accent small-caps label in the preview) |
| Body | no marker |

Title vs Heading 1 and Subtitle vs Heading 2 share syntax, so the style selector and the preview tell them apart by position. Inline: Bold
`**x**` (`Ctrl+B`), Italic `*x*` (`Ctrl+I`), Strikethrough `~~x~~` (`Ctrl+Shift+X`); they wrap the selection (whitespace stays outside the
markers), toggle off when already applied, and with no selection insert the markers with the caret between. All edits go through the native
undo stack. **Insert Table** asks for rows and columns and inserts an aligned Markdown table. The **Preview** button shows a read-only rendered
side pane (plain text for `.txt`). In `.txt` files the markers are inserted as ordinary characters only when you use a formatting action.

**Word wrap** - toolbar button or `Alt+Z`; visual only (no line breaks are inserted), selection preserved, applies to all tabs, remembered.
Default is off, as in v1.

## Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/Cmd + S | Save |
| Ctrl/Cmd + N | New file (explorer when a folder is open, otherwise an untitled tab) |
| Ctrl/Cmd + W | Close tab |
| Ctrl + Tab / Ctrl + Shift + Tab | Next / previous tab |
| Ctrl/Cmd + F | Find in document |
| Ctrl/Cmd + Shift + F | Search workspace |
| Ctrl/Cmd + B / I | Bold / italic (editor focused) |
| Ctrl/Cmd + Shift + X | Strikethrough |
| Alt + Z | Toggle word wrap |
| Ctrl/Cmd + O | Open folder |
| Ctrl/Cmd + \ | Toggle sidebar (**was Ctrl+B in v1**; moved so Ctrl+B can be Bold) |
| Esc | Close menu / search / inline input |

## Performance

Optimisations made: constant-time work per keystroke (the full text is no longer read or compared on every key - the exact unsaved check,
counters, search refresh and preview run once typing pauses); the saved baseline is kept as length + 53-bit hash instead of a second copy of the
document; explorer updates only the affected folder (and skips re-rendering when a re-read finds no change), large folders render in chunks of
500 rows; window-focus re-sync is throttled to once per 4 s; closed tabs release their DOM and queued work; no polling, no intervals, one
window, no runtime dependencies; decorative CSS transitions removed. Optional switches in `app.config.json` -> `performance`
(`disableHardwareAcceleration`, `disableFeatures`) are provided but **off by default and not measured on Windows**.

Measured with `tools/measure.js` (Linux, Xvfb, software rendering, Electron 45.3.2, 3 runs, median; memory is PSS summed over all Electron
processes; same workspace and scripted actions for both versions; 1 MB / 15,000-line document):

| Scenario | Output |
|---|---|
| Startup to first tree render | 520 ms |
| Idle memory (7 processes) | 247.0 MB |
| Idle CPU | 0.1 % |
| 5 tabs open | 256.4 MB |
| 1 MB document open | 362.9 MB |
| After typing and searching in it | 321.8 MB |
| Typing latency in the 1 MB document, median / p95 | 1056 / 1104 ms |
| CPU while searching in it | 2.6 % |

## Security model

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, strict CSP (`script-src 'self'`, `connect-src 'none'`), all network requests
and permission prompts blocked, navigation/new windows denied. Every IPC call is accepted only from the app's own page. All paths are resolved
with `realpath` in the main process and must stay inside the workspace (symlink escapes and `..` are rejected). OS drops are read from real
`File` objects inside `preload.js`, so renderer code cannot inject paths; dropped files become accessible only individually, and a dropped folder
becomes the workspace only through the main process. Moves refuse to overwrite and refuse targets inside the moved folder. Workspace search
runs in the main process with size, count and cancellation limits.

## Project structure

```
app.config.json          Application name, ids, metadata, icon, optional performance switches
electron-builder.config.js  Packaging config generated from app.config.json
main.js / preload.js     Main process (filesystem, IPC, search, drop, move) and the secure bridge
index.html, styles.css, theme-init.js, renderer.js
js/utils.js, dialog.js   Helpers, themed dialogs
js/editor.js             Documents, tabs, saving, status bar, word wrap
js/explorer.js           Tree (incremental rendering), inline naming, context menu, internal drag and drop
js/find.js               Document + workspace search, highlight layer
js/format.js             Styles, bold/italic/strike, tables
js/markdown.js           Read-only Markdown preview (builds DOM nodes, never injects HTML)
tools/measure.js         Linux performance harness
assets/icons/icon.png    Application icon
```

## Known limitations

- Workspace search results come from files on disk, not from unsaved edits.
- Match highlighting is skipped for documents above 300,000 characters; the preview shows the first 300,000 characters.
- Only `.txt` and `.md` are editable; other files are listed greyed out and never touched. Moves cannot cross drives.
- Typing in very large files (about 1 MB and up) is slow because of the browser textarea (see Performance).
- Packaging was validated on Linux: `win-unpacked/<executableName>.exe` and the installer file name were generated from `app.config.json`, but the full NSIS/portable build needs Windows (on Linux it stops because Wine is missing), and the resulting installer was not run on Windows here.
