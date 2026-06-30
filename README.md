# Auto Linker — Obsidian Plugin

Automatically wraps unlinked terms in `[[wikilinks]]` as you write. When you finish typing a word that matches a note in your vault, it gets linked instantly — no manual brackets needed.

---

## How it works

After every **space**, **punctuation mark**, or **Enter**, the plugin checks the word you just finished. If it matches a vault note (by filename or alias), it becomes a link.

**Multi-word note names** are handled too. If you have a note called *Moby Dick*, the plugin links the first word (`[[Moby]]`) and upgrades it when you type the second (`[[Moby Dick]]`). To keep the words separate and unlinked, add a comma: `Moby, Dick` — the comma breaks the chain.

**Matching rules:**
- Exact filename match (case-insensitive)
- Frontmatter aliases
- Ghost links — terms like `[[Ahab]]` or `[[Pequod]]` that are already used as links somewhere in the vault but have no backing note yet. These get linked too, keeping your graph connected even around stubs and themes.
- Simple plural/singular: a note called *whale* links when you write *whales*, and vice versa

**The plugin never touches:**
- Frontmatter (`---` blocks)
- Fenced code blocks and inline code
- Existing `[[links]]`
- Markdown `[text](url)` links
- The note you are currently editing

---

## Installation

This plugin is not yet in the Obsidian community plugin directory. Install it manually:

1. Download `main.js` and `manifest.json` from this folder
2. In your vault, go to `.obsidian/plugins/` and create a new folder called `auto-linker`
3. Copy both files into `.obsidian/plugins/auto-linker/`
4. Open Obsidian → **Settings → Community plugins**
5. Turn off **Restricted mode** if it is on
6. Find **Auto Linker** in the installed plugins list and toggle it on

---

## Updating the plugin

When new versions of `main.js` are available, copy the file into `.obsidian/plugins/auto-linker/` and reload the plugin in Obsidian:

1. **Settings → Community plugins**
2. Toggle **Auto Linker** off
3. Toggle it back on

Obsidian does not reload plugins automatically when files change on disk.

---

## Manual linking

To link an entire existing note at once, open the **Command palette** (`Cmd/Ctrl + P`) and run:

> **Auto Linker: Link entire note now**

This scans the full note and links all unlinked matches in one pass.

---

## Settings

No settings panel yet. The plugin works out of the box with sensible defaults:
- Terms shorter than 3 characters are ignored
- Linking fires immediately (no delay)

---

## Known limitations

- If a short note name (e.g. *Moby*) and a longer one (e.g. *Moby Dick*) both exist, the upgrade logic assumes you always mean the longer name when you type the next matching word. Use a comma to opt out.
- Very large vaults (thousands of notes) may have a slight delay on the first load while the index builds.

