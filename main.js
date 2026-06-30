'use strict';

var obsidian = require('obsidian');

// ---------------------------------------------------------------------------
// Auto Linker — Obsidian Plugin
//
// Checks the just-completed word immediately after every space, comma,
// punctuation, or Enter keypress. If the word (or phrase) matches a vault
// filename or frontmatter alias, it is wrapped in [[wikilinks]] in-place.
//
// Matching:
//   1. Exact filename (case-insensitive)
//   2. Frontmatter aliases
//   3. Simple plural/singular: "mushroom" ↔ "mushrooms"
//   4. Multi-word upgrade: if [[SiteControl]] is already linked and the next
//      word(s) extend it to a longer vault match (e.g. "SiteControl Grow"),
//      the link is upgraded to [[SiteControl Grow]].
//      A comma or punctuation between words breaks the upgrade chain.
//
// Skipped: frontmatter, fenced code blocks, inline code, existing [[links]],
//          markdown [text](url) links, the current file itself.
// ---------------------------------------------------------------------------

class AutoLinkerPlugin extends obsidian.Plugin {

    async onload() {
        this.vaultIndex = [];
        this._isLinking = false;

        this.app.workspace.onLayoutReady(() => {
            this.buildVaultIndex();
        });

        this.registerEvent(this.app.vault.on('create',  () => this.buildVaultIndex()));
        this.registerEvent(this.app.vault.on('delete',  () => this.buildVaultIndex()));
        this.registerEvent(this.app.vault.on('rename',  () => this.buildVaultIndex()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.buildVaultIndex()));

        // Immediate check on every editor change
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor, view) => {
                if (this._isLinking) return;
                this.handleWordComplete(editor, view);
            })
        );

        // Manual command: scan and link the entire note
        this.addCommand({
            id: 'auto-link-note',
            name: 'Link entire note now',
            editorCallback: (editor, view) => {
                this.linkEntireNote(editor, view);
            }
        });

    }

    onunload() {
    }

    // -----------------------------------------------------------------------
    // Vault index
    // -----------------------------------------------------------------------

    buildVaultIndex() {
        this.vaultIndex = [];

        // 1. Real notes (with files)
        for (const file of this.app.vault.getMarkdownFiles()) {
            const cache = this.app.metadataCache.getFileCache(file);
            const aliases = [];

            if (cache?.frontmatter?.aliases) {
                const raw = cache.frontmatter.aliases;
                if (Array.isArray(raw)) {
                    aliases.push(...raw.filter(a => typeof a === 'string' && a.length >= 3));
                } else if (typeof raw === 'string' && raw.length >= 3) {
                    aliases.push(raw);
                }
            }

            this.vaultIndex.push({ name: file.basename, aliases, file, ghost: false });
        }

        // 2. Ghost links — wikilinks used across the vault that have no file yet.
        //    These act as tags/themes (e.g. [[Tailscale]], [[Homelab]]) and are
        //    worth auto-linking even without a backing note.
        const realNames = new Set(this.vaultIndex.map(e => e.name.toLowerCase()));
        const ghostNames = new Set();

        for (const targets of Object.values(this.app.metadataCache.unresolvedLinks)) {
            for (const linkName of Object.keys(targets)) {
                const lower = linkName.toLowerCase();
                if (!realNames.has(lower) && !ghostNames.has(lower) && linkName.length >= 3) {
                    ghostNames.add(lower);
                    this.vaultIndex.push({ name: linkName, aliases: [], file: null, ghost: true });
                }
            }
        }

        // Longest names first — ensures multi-word names matched before shorter subsets
        this.vaultIndex.sort((a, b) => b.name.length - a.name.length);

        // Precompute max word count across all entry names (used to cap upgrade checks)
        this._maxLinkWords = Math.max(1, ...this.vaultIndex.map(e => e.name.split(/\s+/).length));
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
            lineIndex = cursor.line - 1;
            lineText  = editor.getLine(lineIndex);
            textToCheck = lineText;
        } else {
            lineText = editor.getLine(cursor.line);
            const charBefore = lineText[cursor.ch - 1];

            // Only act on word-boundary characters
            if (!charBefore || !/[ \t,\.!?;:]/.test(charBefore)) return;

            lineIndex   = cursor.line;
            textToCheck = lineText.slice(0, cursor.ch - 1); // exclude the trigger char
        }

        // Skip lines that are inside a fenced code block or are indented code
        if (this.lineIsInCodeBlock(editor, lineIndex)) return;

        // Skip if cursor is inside an existing [[link]] or `inline code`
        if (/`[^`]*$/.test(textToCheck)) return;         // unclosed backtick before cursor
        if (/\[\[[^\]]*$/.test(textToCheck)) return;      // unclosed [[ before cursor

        // --- Upgrade check ---------------------------------------------------
        // If textToCheck ends with [[ExistingLink]] word(s), try to find a
        // longer vault entry that equals "ExistingLinkName + trailing words".
        // A comma/punctuation between the link and the words prevents this
        // because it would have triggered its own word-boundary event and the
        // space after punctuation won't leave a bare [[Link]] immediately
        // adjacent to the new word.
        if (this.tryUpgradeLink(editor, view, lineIndex, textToCheck, cursor)) return;

        // --- Normal per-word check -------------------------------------------
        // Try each vault entry (longest first)
        for (const entry of this.vaultIndex) {
            if (entry.file === view.file) continue;

            const terms = [entry.name, ...entry.aliases];

            for (const term of terms) {
                if (!term || term.length < 3) continue;

                const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // Match at the END of textToCheck, whole-word, not preceded by [
                const regex = new RegExp(`(?<!\\[)\\b(${escaped}s?)$`, 'i');
                const match = regex.exec(textToCheck);
                if (!match) continue;

                const captured  = match[1];
                const matchStart = match.index;
                const matchEnd   = matchStart + captured.length;

                // Extra guard: not already [[linked]]
                if (lineText.slice(0, matchStart).endsWith('[[')) continue;

                const linked = (captured.toLowerCase() === entry.name.toLowerCase())
                    ? `[[${entry.name}]]`
                    : `[[${entry.name}|${captured}]]`;

                this._isLinking = true;
                editor.replaceRange(
                    linked,
                    { line: lineIndex, ch: matchStart },
                    { line: lineIndex, ch: matchEnd }
                );
                this._isLinking = false;

                return; // one match per keystroke is enough
            }
        }
    }

    // -----------------------------------------------------------------------
    // Upgrade: [[ExistingLink]] word(s) → [[LongerNoteName]]
    //
    // Looks for a pattern like [[SiteControl]] Grow at the end of textToCheck
    // and checks whether "SiteControl Grow" (or "SiteControl Grow Pro", etc.)
    // exists as a vault note. If so, replaces the whole thing with the longer
    // link. Works for any number of trailing words.
    // Returns true if an upgrade was applied.
    // -----------------------------------------------------------------------

    tryUpgradeLink(editor, view, lineIndex, textToCheck, cursor) {
        // Match the last [[link]] on the line followed by plain words.
        // Trailing words stop at brackets and sentence punctuation so the
        // chain breaks naturally at commas, periods, etc.
        // The word count is capped at (_maxLinkWords - 1) so we never check
        // combinations longer than the longest note name in the vault.
        const m = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]((?:\s+[^\s\[\].,;:!?]+)+)$/.exec(textToCheck);
        if (!m) return false;

        const linkName     = m[1];
        const trailingParts = m[2].match(/\s+[^\s\[\].,;:!?]+/g) || [];
        const maxTrailing   = Math.max(1, (this._maxLinkWords || 1) - 1);
        const partsToCheck  = trailingParts.slice(0, maxTrailing);

        // Try longest combination first (handles 3-word names before 2-word)
        for (let len = partsToCheck.length; len >= 1; len--) {
            const trailingText = partsToCheck.slice(0, len).map(p => p.trim()).join(' ');
            const combined     = linkName + ' ' + trailingText;

            for (const entry of this.vaultIndex) {
                if (entry.file === view.file) continue;

                for (const term of [entry.name, ...entry.aliases]) {
                    if (term.toLowerCase() !== combined.toLowerCase()) continue;

                    // Compute the exact replacement range:
                    // [[linkName]] + the first `len` trailing parts (with their spaces)
                    const replacedText = '[[' + m[1] + ']]' + partsToCheck.slice(0, len).join('');
                    const matchStart   = m.index;
                    const matchEnd     = matchStart + replacedText.length;
                    const linked       = `[[${entry.name}]]`;
                    const lengthDiff   = linked.length - replacedText.length;

                    this._isLinking = true;
                    editor.replaceRange(
                        linked,
                        { line: lineIndex, ch: matchStart },
                        { line: lineIndex, ch: matchEnd }
                    );
                    if (lineIndex === cursor.line) {
                        editor.setCursor({ line: cursor.line, ch: cursor.ch + lengthDiff });
                    }
                    this._isLinking = false;
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

        const content = editor.getValue();
        const newContent = this.processContent(content, view.file);
        if (newContent === content) return;

        const cursor = editor.getCursor();
        this._isLinking = true;
        editor.setValue(newContent);
        editor.setCursor(cursor);
        this._isLinking = false;
    }

    processContent(content, currentFile) {
        let frontmatter = '';
        let body = content;
        const fmMatch = content.match(/^---[\r\n][\s\S]*?[\r\n]---[\r\n]/);
        if (fmMatch) {
            frontmatter = fmMatch[0];
            body = content.slice(frontmatter.length);
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

        return segments.map(seg => seg.process ? this.linkifyText(seg.text, currentFile) : seg.text).join('');
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

                const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex   = new RegExp(`(?<!\\[)\\b(${escaped}s?)\\b(?!\\])`, 'gi');

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
    // Helper: detect if a given line number is inside a fenced code block
    // -----------------------------------------------------------------------

    lineIsInCodeBlock(editor, targetLine) {
        let inCode = false;
        for (let i = 0; i < targetLine; i++) {
            const l = editor.getLine(i);
            if (/^```|^~~~/.test(l)) inCode = !inCode;
        }
        return inCode;
    }
}

module.exports = AutoLinkerPlugin;
