'use strict';

var obsidian = require('obsidian');

// ---------------------------------------------------------------------------
// Auto Linker — Obsidian Plugin  v1.0.6
//
// Checks the just-completed word immediately after every space, comma,
// punctuation, or Enter keypress. If the word (or phrase) matches a vault
// filename or frontmatter alias, it is wrapped in [[wikilinks]] in-place.
//
// Matching:
//   1. Exact filename (case-insensitive)
//   2. Frontmatter aliases
//   3. Simple plural/singular: "mushroom" ↔ "mushrooms"
//   4. Multi-word upgrade: if [[Moby]] is already linked and the next
//      word extends it to a longer vault match (e.g. "Moby Dick"),
//      the link is upgraded to [[Moby Dick]].
//      A comma or punctuation between words breaks the upgrade chain.
//   5. Ghost links: wikilinks used elsewhere in the vault that have no
//      backing note yet are auto-linked too.
//
// Skipped: frontmatter, fenced code blocks, inline code, existing [[links]],
//          markdown [text](url) links, the current file itself.
// ---------------------------------------------------------------------------

class AutoLinkerPlugin extends obsidian.Plugin {

    async onload() {
        this.vaultIndex  = [];
        this._isLinking  = false;

        // Debounced rebuild — prevents O(n²) storm during vault startup
        // when metadataCache fires once per file indexed.
        this._rebuildIndex = obsidian.debounce(() => this.buildVaultIndex(), 500);

        this.app.workspace.onLayoutReady(() => {
            this.buildVaultIndex(); // immediate on first load
        });

        this.registerEvent(this.app.vault.on('create',  () => this._rebuildIndex()));
        this.registerEvent(this.app.vault.on('delete',  () => this._rebuildIndex()));
        this.registerEvent(this.app.vault.on('rename',  () => this._rebuildIndex()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this._rebuildIndex()));

        this.registerEvent(
            this.app.workspace.on('editor-change', (editor, view) => {
                if (this._isLinking) return;
                this.handleWordComplete(editor, view);
            })
        );

        this.addCommand({
            id: 'auto-link-note',
            name: 'Link entire note now',
            editorCallback: (editor, view) => {
                this.linkEntireNote(editor, view);
            }
        });
    }

    onunload() {}

    // -----------------------------------------------------------------------
    // Safety validation — rejects names that would break wikilink syntax or
    // be too short/long to be useful. Applied to filenames, aliases, and
    // ghost link names before they enter the index.
    // -----------------------------------------------------------------------

    _isSafeName(name) {
        return typeof name === 'string'
            && name.length >= 3
            && name.length <= 100
            && !/[\[\]|\n\r]/.test(name);
    }

    // -----------------------------------------------------------------------
    // Vault index
    // -----------------------------------------------------------------------

    buildVaultIndex() {
        this.vaultIndex = [];

        // 1. Real notes (with files)
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (!this._isSafeName(file.basename)) continue;

            const cache = this.app.metadataCache.getFileCache(file);
            const aliases = [];

            if (cache?.frontmatter?.aliases) {
                const raw = cache.frontmatter.aliases;
                if (Array.isArray(raw)) {
                    aliases.push(...raw.filter(a => this._isSafeName(a)));
                } else if (this._isSafeName(raw)) {
                    aliases.push(raw);
                }
            }

            this.vaultIndex.push({ name: file.basename, aliases, file, ghost: false });
        }

        // 2. Ghost links — wikilinks used across the vault that have no file yet.
        const realNames  = new Set(this.vaultIndex.map(e => e.name.toLowerCase()));
        const ghostNames = new Set();

        for (const targets of Object.values(this.app.metadataCache.unresolvedLinks)) {
            for (const linkName of Object.keys(targets)) {
                // Guard against prototype-polluted objects
                if (!Object.hasOwn(targets, linkName)) continue;
                const lower = linkName.toLowerCase();
                if (!realNames.has(lower) && !ghostNames.has(lower) && this._isSafeName(linkName)) {
                    ghostNames.add(lower);
                    this.vaultIndex.push({ name: linkName, aliases: [], file: null, ghost: true });
                }
            }
        }

        // Longest names first — ensures "Moby Dick" matched before "Moby"
        this.vaultIndex.sort((a, b) => b.name.length - a.name.length);

        // Max word count via reduce — Math.max(...spread) throws RangeError on large arrays
        this._maxLinkWords = this.vaultIndex.reduce(
            (max, e) => Math.max(max, e.name.split(/\s+/).length), 1
        );

        // Pre-compile regexes once per index build rather than on every keypress.
        // end  = matches the term at end-of-string (used in per-word check)
        // any  = matches the term anywhere in text (used in full-note scan)
        for (const entry of this.vaultIndex) {
            entry.regexCache = {};
            for (const term of [entry.name, ...entry.aliases]) {
                const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                entry.regexCache[term] = {
                    end: new RegExp(`(?<!\\[)\\b(${escaped}s?)$`,          'i'),
                    any: new RegExp(`(?<!\\[)\\b(${escaped}s?)\\b(?!\\])`, 'gi'),
                };
            }
        }

        // Pre-build the upgrade regex with a bounded quantifier {1,N} to prevent
        // nested-quantifier ReDoS in tryUpgradeLink.
        const maxT = Math.max(1, this._maxLinkWords - 1);
        this._maxTrailing  = maxT;
        this._upgradeRegex = new RegExp(
            `\\[\\[([^\\]|]+?)(?:\\|[^\\]]*)?\\]\\]((?:\\s+[^\\s\\[\\].,;:!?]+){1,${maxT}})$`
        );
    }

    // -----------------------------------------------------------------------
    // Per-word check (fires immediately after space, punctuation, or Enter)
    // -----------------------------------------------------------------------

    handleWordComplete(editor, view) {
        if (!view?.file) return;

        const cursor = editor.getCursor();
        let lineIndex, lineText, textToCheck;

        if (cursor.ch === 0 && cursor.line > 0) {
            // Enter was pressed — check the end of the previous line
            lineIndex   = cursor.line - 1;
            lineText    = editor.getLine(lineIndex);
            textToCheck = lineText;
        } else {
            lineText = editor.getLine(cursor.line);
            const charBefore = lineText[cursor.ch - 1];

            // Only act on word-boundary characters
            if (!charBefore || !/[ \t,\.!?;:]/.test(charBefore)) return;

            lineIndex   = cursor.line;
            textToCheck = lineText.slice(0, cursor.ch - 1); // exclude the trigger char
        }

        if (this.lineIsInCodeBlock(editor, lineIndex)) return;

        // Skip if inside an unclosed `inline code` or [[link
        if (/`[^`]*$/.test(textToCheck))    return;
        if (/\[\[[^\]]*$/.test(textToCheck)) return;

        if (this.tryUpgradeLink(editor, view, lineIndex, textToCheck, cursor)) return;

        for (const entry of this.vaultIndex) {
            if (entry.file === view.file) continue;

            for (const term of [entry.name, ...entry.aliases]) {
                if (!term || term.length < 3) continue;

                const regex = entry.regexCache?.[term]?.end;
                if (!regex) continue;

                const match = regex.exec(textToCheck);
                if (!match) continue;

                const captured   = match[1];
                const matchStart = match.index;
                const matchEnd   = matchStart + captured.length;

                if (lineText.slice(0, matchStart).endsWith('[[')) continue;

                const linked = (captured.toLowerCase() === entry.name.toLowerCase())
                    ? `[[${entry.name}]]`
                    : `[[${entry.name}|${captured}]]`;

                this._isLinking = true;
                try {
                    editor.replaceRange(
                        linked,
                        { line: lineIndex, ch: matchStart },
                        { line: lineIndex, ch: matchEnd }
                    );
                } finally {
                    this._isLinking = false;
                }
                return;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Upgrade: [[ExistingLink]] word(s) → [[LongerNoteName]]
    // Uses a pre-built bounded regex to avoid nested-quantifier ReDoS.
    // -----------------------------------------------------------------------

    tryUpgradeLink(editor, view, lineIndex, textToCheck, cursor) {
        if (!this._upgradeRegex) return false;

        const m = this._upgradeRegex.exec(textToCheck);
        if (!m) return false;

        const linkName      = m[1];
        const trailingParts = m[2].match(/\s+[^\s\[\].,;:!?]+/g) || [];
        const partsToCheck  = trailingParts.slice(0, this._maxTrailing || 5);

        for (let len = partsToCheck.length; len >= 1; len--) {
            const trailingText = partsToCheck.slice(0, len).map(p => p.trim()).join(' ');
            const combined     = linkName + ' ' + trailingText;

            for (const entry of this.vaultIndex) {
                if (entry.file === view.file) continue;

                for (const term of [entry.name, ...entry.aliases]) {
                    if (term.toLowerCase() !== combined.toLowerCase()) continue;

                    const replacedText = '[[' + m[1] + ']]' + partsToCheck.slice(0, len).join('');
                    const matchStart   = m.index;
                    const matchEnd     = matchStart + replacedText.length;
                    const linked       = `[[${entry.name}]]`;
                    const lengthDiff   = linked.length - replacedText.length;

                    this._isLinking = true;
                    try {
                        editor.replaceRange(
                            linked,
                            { line: lineIndex, ch: matchStart },
                            { line: lineIndex, ch: matchEnd }
                        );
                        if (lineIndex === cursor.line) {
                            editor.setCursor({ line: cursor.line, ch: cursor.ch + lengthDiff });
                        }
                    } finally {
                        this._isLinking = false;
                    }
                    return true;
                }
            }
        }
        return false;
    }

    // -----------------------------------------------------------------------
    // Manual full-note scan (Command palette)
    // -----------------------------------------------------------------------

    linkEntireNote(editor, view) {
        if (!view?.file) return;

        const content    = editor.getValue();
        const newContent = this.processContent(content, view.file);
        if (newContent === content) return;

        const cursor = editor.getCursor();
        this._isLinking = true;
        try {
            editor.setValue(newContent);
            editor.setCursor(cursor);
        } finally {
            this._isLinking = false;
        }
    }

    processContent(content, currentFile) {
        let frontmatter = '';
        let body = content;

        // startsWith guard avoids scanning large notes that have no frontmatter
        if (content.startsWith('---')) {
            const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
            if (fmMatch) {
                frontmatter = fmMatch[0];
                body        = content.slice(frontmatter.length);
            }
        }
        return frontmatter + this.processBody(body, currentFile);
    }

    processBody(body, currentFile) {
        const SKIP = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)/g;
        const segments = [];
        let last = 0, m;

        while ((m = SKIP.exec(body)) !== null) {
            if (m.index > last) segments.push({ text: body.slice(last, m.index), process: true });
            segments.push({ text: m[0], process: false });
            last = m.index + m[0].length;
        }
        if (last < body.length) segments.push({ text: body.slice(last), process: true });

        return segments
            .map(seg => seg.process ? this.linkifyText(seg.text, currentFile) : seg.text)
            .join('');
    }

    linkifyText(text, currentFile) {
        for (const entry of this.vaultIndex) {
            if (entry.file === currentFile) continue;

            for (const term of [entry.name, ...entry.aliases]) {
                if (!term || term.length < 3) continue;

                const lower = term.toLowerCase();
                const tl    = text.toLowerCase();
                const stem  = lower.endsWith('s') ? lower.slice(0, -1) : lower;
                if (!tl.includes(lower) && !tl.includes(stem)) continue;

                const regex = entry.regexCache?.[term]?.any;
                if (!regex) continue;
                regex.lastIndex = 0; // reset global flag before reuse

                text = text.replace(regex, (_, captured) => {
                    return (captured.toLowerCase() === entry.name.toLowerCase())
                        ? `[[${entry.name}]]`
                        : `[[${entry.name}|${captured}]]`;
                });
            }
        }
        return text;
    }

    // -----------------------------------------------------------------------
    // Helper: detect if a line is inside a fenced code block.
    // Scans from line 0 — O(n) in note length. This is a known limitation;
    // a proper fix would use CodeMirror 6's syntax tree for O(1) lookup.
    // -----------------------------------------------------------------------

    lineIsInCodeBlock(editor, targetLine) {
        if (targetLine === 0) return false;
        let inCode = false;
        for (let i = 0; i < targetLine; i++) {
            const l = editor.getLine(i);
            if (/^```|^~~~/.test(l)) inCode = !inCode;
        }
        return inCode;
    }
}

module.exports = AutoLinkerPlugin;
