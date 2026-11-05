#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Docs gate: `pnpm link:check` (docs/009 §4)
//
// Offline, zero-dependency markdown link checker. It mimics how GitHub renders
// repository markdown:
//   - relative links resolve against the *repository root* (and against the
//     containing file for links without a leading slash);
//   - paths are case-sensitive even on a case-insensitive filesystem;
//   - `#anchor` fragments must match a GitHub heading slug in the target file;
//   - links inside fenced code blocks, inline code spans and HTML comments are
//     examples, not links;
//   - http(s)/mailto/other scheme links are external and are not fetched.
//
// Scanned roots are the docs that ship with v1.0 (README + root policies, the
// docs/ and handoffs/ trees, SAP/example/GitHub docs). CHANGELOG.md and the
// extension README are scanned when present (release docs owned by other
// workstreams); missing optional files are skipped.
//
// Usage:
//   node scripts/link-check.mjs          human-readable report
//   node scripts/link-check.mjs --json   machine-readable report
//
// Exit code: 0 = clean, 1 = broken links, 2 = usage error.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Markdown entry points scanned by this gate. */
const SCAN_ENTRIES = [
  'README.md',
  'HANDOFF.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'docs',
  'handoffs',
  'sap/README.md',
  'examples',
  '.github',
];

/** Release docs from other workstreams: scanned if present, skipped otherwise. */
const OPTIONAL_SCAN_ENTRIES = ['CHANGELOG.md', 'packages/clients/vscode/README.md'];

const SKIP_DIR_NAMES = new Set(['node_modules', 'tmp', '.git']);
const MARKDOWN_EXT = /\.(md|markdown)$/i;

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function collectMarkdownFiles(absolutePath, out) {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (MARKDOWN_EXT.test(absolutePath)) out.push(absolutePath);
    return;
  }
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    collectMarkdownFiles(join(absolutePath, entry.name), out);
  }
}

function toRepoPath(absolutePath) {
  const relativePath = absolutePath.startsWith(ROOT)
    ? absolutePath.slice(ROOT.length)
    : absolutePath;
  return relativePath.split(sep).join('/').replace(/^\/+/, '');
}

/**
 * Resolve `relativePath` under ROOT segment by segment, comparing directory
 * entries exactly. `existsSync` is unusable here: macOS/Windows checkouts are
 * case-insensitive, while GitHub (and CI) is not.
 * Returns `{ kind: 'file' | 'directory', path }` or `{ kind: 'missing' }` /
 * `{ kind: 'case', actual }` / `{ kind: 'not-directory' }`.
 */
function statExact(relativePath) {
  const segments = relativePath.split('/').filter((segment) => segment !== '' && segment !== '.');
  let current = ROOT;
  const walked = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '..') {
      current = dirname(current);
      walked.pop();
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return { kind: 'missing' };
    }
    const exact = entries.find((entry) => entry.name === segment);
    if (exact === undefined) {
      const caseOnly = entries.find(
        (entry) => entry.name.toLowerCase() === segment.toLowerCase(),
      );
      if (caseOnly !== undefined) {
        return { kind: 'case', actual: [...walked, caseOnly.name].join('/') };
      }
      return { kind: 'missing' };
    }
    walked.push(segment);
    const nextPath = join(current, exact.name);
    const last = index === segments.length - 1;
    if (last) {
      return {
        kind: exact.isDirectory() ? 'directory' : 'file',
        path: nextPath,
      };
    }
    if (!exact.isDirectory()) return { kind: 'not-directory' };
    current = nextPath;
  }
  return { kind: 'directory', path: current };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isWithinRoot(absolutePath) {
  const relativePath = toRepoPath(absolutePath);
  return !relativePath.startsWith('..');
}

// ---------------------------------------------------------------------------
// Masking: replace code/comments with spaces while preserving offsets so
// findings still point at the original line/column.
// ---------------------------------------------------------------------------

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines.push({ start, end: index });
      start = index + 1;
    }
  }
  lines.push({ start, end: text.length });
  return lines;
}

function maskRange(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

function maskFencedCode(chars, lines) {
  let fence = null;
  for (const line of lines) {
    const text = chars.slice(line.start, line.end).join('');
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence === null) {
      if (match !== null && !(match[2][0] === '`' && match[3].includes('`'))) {
        fence = { char: match[2][0], length: match[2].length, start: line.start, info: match[3] };
      }
      continue;
    }
    // A closing fence is the same character, at least as long, with no info string.
    if (
      match !== null &&
      match[2][0] === fence.char &&
      match[2].length >= fence.length &&
      match[3].trim() === ''
    ) {
      maskRange(chars, fence.start, line.end);
      fence = null;
    }
  }
  if (fence !== null) maskRange(chars, fence.start, chars.length);
}

function maskHtmlComments(chars) {
  let text = chars.join('');
  let index = 0;
  while ((index = text.indexOf('<!--', index)) !== -1) {
    const end = text.indexOf('-->', index + 4);
    if (end === -1) {
      maskRange(chars, index, chars.length);
      return;
    }
    maskRange(chars, index, end + 3);
    text = chars.join('');
    index = end + 3;
  }
}

function maskFrontMatter(chars, lines) {
  if (lines.length < 2) return;
  const first = chars.slice(lines[0].start, lines[0].end).join('').trim();
  if (first !== '---') return;
  for (let index = 1; index < lines.length; index += 1) {
    const text = chars.slice(lines[index].start, lines[index].end).join('').trim();
    if (text === '---' || text === '...') {
      maskRange(chars, lines[0].start, lines[index].end);
      return;
    }
  }
}

/** Mask inline code spans (`...`, ``...``, ...) including their content. */
function maskInlineCode(chars) {
  const text = chars.join('');
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (text[index + runLength] === '`') runLength += 1;
    let cursor = index + runLength;
    let closed = false;
    while (cursor < text.length) {
      if (text[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let candidate = 1;
      while (text[cursor + candidate] === '`') candidate += 1;
      if (candidate === runLength) {
        maskRange(chars, index, cursor + candidate);
        index = cursor + candidate;
        closed = true;
        break;
      }
      cursor += candidate;
    }
    if (!closed) index += runLength;
  }
}

/**
 * Return the text with code/comments blanked. `{ inlineCode: true }` also
 * blanks inline code; anchors need the inline-code *content* (it is part of the
 * rendered heading text), so they use the version without that mask.
 */
function maskDocument(text, options = {}) {
  const chars = text.split('');
  const lines = splitLines(text);
  maskFrontMatter(chars, lines);
  maskFencedCode(chars, lines);
  maskHtmlComments(chars);
  if (options.inlineCode === true) maskInlineCode(chars);
  return chars.join('');
}

// ---------------------------------------------------------------------------
// GitHub heading slugs
// ---------------------------------------------------------------------------

/** GitHub strips punctuation/symbols, keeps letters/numbers/`_`/`-`, spaces -> `-`. */
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Reduce inline markdown to the text GitHub would render inside a heading. */
function renderedHeadingText(markdown) {
  let text = markdown;
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/`+/g, '');
  text = text.replace(/[*~]/g, '');
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
  return text.trim();
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const NON_PARAGRAPH_START = /^ {0,3}(#{1,6}[ \t]|>|[-*+][ \t]|\d+[.)][ \t]|\|)/;

/** Collect every anchor GitHub would generate for a markdown file. */
function collectAnchors(absolutePath) {
  const text = readFileSync(absolutePath, 'utf8');
  const masked = maskDocument(text);
  const lines = splitLines(masked);
  const used = new Set();

  const explicitId = /<[a-z][^>]*\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let idMatch;
  while ((idMatch = explicitId.exec(masked)) !== null) {
    const id = idMatch[1] ?? idMatch[2];
    if (id !== undefined && id !== '') used.add(id);
  }

  const addHeading = (rawText) => {
    const base = slugifyHeading(renderedHeadingText(rawText));
    if (base === '') return;
    let candidate = base;
    let suffix = 0;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    used.add(candidate);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const textLine = masked.slice(line.start, line.end);
    const atx = ATX_HEADING.exec(textLine);
    if (atx !== null) {
      const raw = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '');
      addHeading(raw);
      continue;
    }
    if (index + 1 >= lines.length) continue;
    const nextLine = masked.slice(lines[index + 1].start, lines[index + 1].end);
    if (!SETEXT_UNDERLINE.test(nextLine)) continue;
    const paragraph = textLine.trim();
    if (paragraph === '' || NON_PARAGRAPH_START.test(textLine)) continue;
    addHeading(paragraph);
    index += 1;
  }

  return used;
}

// ---------------------------------------------------------------------------
// Link parsing
// ---------------------------------------------------------------------------

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findClosingBracket(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (isEscaped(text, index)) continue;
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingParen(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (isEscaped(text, index)) continue;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor += 1;
  return cursor;
}

/** Parse `(destination "title")` starting at the `(`; returns the target or null. */
function parseInlineDestination(text, openParenIndex) {
  const closeParen = findClosingParen(text, openParenIndex);
  if (closeParen === -1) return null;
  let cursor = skipWhitespace(text, openParenIndex + 1);
  let target;
  if (text[cursor] === '<') {
    const end = text.indexOf('>', cursor + 1);
    if (end === -1 || end > closeParen) return null;
    target = text.slice(cursor + 1, end);
    cursor = end + 1;
  } else {
    const start = cursor;
    let depth = 0;
    while (cursor < closeParen) {
      const char = text[cursor];
      if (isEscaped(text, cursor)) {
        cursor += 2;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && /[ \t\r\n]/.test(char)) {
        break;
      }
      cursor += 1;
    }
    target = text.slice(start, cursor);
  }
  const titleStart = skipWhitespace(text, cursor);
  if (titleStart < closeParen) {
    const quote = text[titleStart];
    if (quote === '"' || quote === "'") {
      const titleEnd = text.indexOf(quote, titleStart + 1);
      if (titleEnd === -1 || titleEnd > closeParen) return null;
      const afterTitle = skipWhitespace(text, titleEnd + 1);
      if (afterTitle !== closeParen) return null;
    } else if (quote === '(') {
      const titleEnd = findClosingParen(text, titleStart);
      if (titleEnd === -1 || titleEnd !== closeParen) return null;
    } else {
      return null;
    }
  }
  return target;
}

/** Parse link reference definitions: `[label]: target "title"`. */
function collectReferenceDefinitions(masked) {
  const definitions = new Map();
  const pattern = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm;
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    const label = match[1].trim().replace(/\s+/g, ' ').toLowerCase();
    let target = match[2];
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (!definitions.has(label)) definitions.set(label, target);
  }
  return definitions;
}

function offsetToLine(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Extract inline links/images (and reference links used by them) from a masked
 * markdown document. Each link records its source line/column in the original.
 */
function collectLinks(masked, lineStarts, referenceDefinitions) {
  const links = [];
  let index = 0;
  while (index < masked.length) {
    if (masked[index] !== '[' || isEscaped(masked, index)) {
      index += 1;
      continue;
    }
    const closeBracket = findClosingBracket(masked, index);
    if (closeBracket === -1) {
      index += 1;
      continue;
    }
    const linkText = masked.slice(index + 1, closeBracket);
    const afterBracket = skipWhitespace(masked, closeBracket + 1);
    let target;
    let end = closeBracket + 1;
    if (masked[afterBracket] === '(') {
      target = parseInlineDestination(masked, afterBracket);
      if (target === null) {
        index = closeBracket + 1;
        continue;
      }
      end = findClosingParen(masked, afterBracket) + 1;
    } else {
      let label;
      if (masked[afterBracket] === '[') {
        const closeLabel = masked.indexOf(']', afterBracket + 1);
        if (closeLabel === -1) {
          index = closeBracket + 1;
          continue;
        }
        label = masked.slice(afterBracket + 1, closeLabel);
        end = closeLabel + 1;
      } else if (masked[afterBracket] === ':') {
        // `[label]: target` is a link reference definition, not a shortcut link.
        index = closeBracket + 1;
        continue;
      } else {
        label = linkText;
      }
      const normalized = label.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!referenceDefinitions.has(normalized)) {
        index = closeBracket + 1;
        continue;
      }
      target = referenceDefinitions.get(normalized);
    }
    if (target !== null && target !== undefined) {
      links.push({
        line: offsetToLine(lineStarts, index),
        column: index - lineStarts[offsetToLine(lineStarts, index)] + 1,
        text: linkText.trim().slice(0, 80),
        target,
        isImage: index > 0 && masked[index - 1] === '!',
      });
    }
    index = Math.max(end, closeBracket + 1);
  }
  return links;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function externalReason(target) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return 'external';
  if (target.startsWith('//')) return 'external';
  return null;
}

/**
 * Validate one link target. Returns `{ kind: 'external' }`,
 * `{ kind: 'ok' }` or `{ kind: 'broken', reason, detail }`.
 */
function validateTarget(link, fromFile, anchorCache) {
  const rawTarget = link.target.trim();
  if (rawTarget === '') return { kind: 'broken', reason: 'empty target' };
  const external = externalReason(rawTarget);
  if (external !== null) return { kind: 'external' };

  const hashIndex = rawTarget.indexOf('#');
  let pathPart = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : rawTarget.slice(hashIndex + 1);
  const queryIndex = pathPart.indexOf('?');
  if (queryIndex !== -1) pathPart = pathPart.slice(0, queryIndex);

  const decodedPath = safeDecode(pathPart);
  // Repository-absolute links (`/docs/x.md`) are valid on GitHub: they resolve
  // against the repository root. Everything else is relative to the file.
  let absoluteTarget;
  if (decodedPath === '') {
    absoluteTarget = fromFile;
  } else if (decodedPath.startsWith('/')) {
    absoluteTarget = isWithinRoot(resolve(ROOT, decodedPath.slice(1)))
      ? resolve(ROOT, decodedPath.slice(1))
      : null;
  } else {
    absoluteTarget = isWithinRoot(resolve(dirname(fromFile), decodedPath))
      ? resolve(dirname(fromFile), decodedPath)
      : null;
  }
  if (absoluteTarget === null) {
    return { kind: 'broken', reason: 'outside repository', detail: decodedPath };
  }

  let resolved;
  if (decodedPath === '') {
    resolved = { kind: 'file', path: fromFile };
  } else {
    const repoRelative = toRepoPath(absoluteTarget);
    const stat = statExact(repoRelative);
    if (stat.kind === 'missing' || stat.kind === 'not-directory') {
      return {
        kind: 'broken',
        reason: stat.kind === 'not-directory' ? 'path component is a file' : 'file not found',
        detail: decodedPath,
      };
    }
    if (stat.kind === 'case') {
      return {
        kind: 'broken',
        reason: 'case mismatch',
        detail: `${decodedPath} -> ${stat.actual}`,
      };
    }
    resolved = stat;
  }

  if (fragment !== '' && resolved !== null && resolved.kind === 'file') {
    if (MARKDOWN_EXT.test(resolved.path)) {
      const anchors = getAnchors(resolved.path, anchorCache);
      const decodedFragment = safeDecode(fragment);
      const found =
        anchors.has(decodedFragment) ||
        anchors.has(decodedFragment.normalize('NFC')) ||
        [...anchors].some((anchor) => anchor.normalize('NFC') === decodedFragment.normalize('NFC'));
      if (!found) {
        return {
          kind: 'broken',
          reason: 'anchor not found',
          detail: `#${decodedFragment} in ${toRepoPath(resolved.path)}`,
        };
      }
    }
    // Non-markdown targets use GitHub line anchors (`#L10-L20`), which we cannot
    // validate offline; existence of the file is enough.
  }

  return { kind: 'ok' };
}

function getAnchors(absolutePath, cache) {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) return cached;
  let anchors;
  try {
    anchors = collectAnchors(absolutePath);
  } catch {
    anchors = new Set();
  }
  cache.set(absolutePath, anchors);
  return anchors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'Usage: node scripts/link-check.mjs [--json]',
      '',
      'Checks relative markdown links and #anchors in the v1.0 docs.',
      'Exit codes: 0 clean, 1 broken links, 2 usage error.',
    ].join('\n'),
  );
  process.exit(0);
}
const unknownArgs = args.filter((arg) => arg !== '--json');
if (unknownArgs.length > 0) {
  console.error(`link-check: unknown argument(s): ${unknownArgs.join(' ')}`);
  process.exit(2);
}

const startedAt = Date.now();
const files = [];
for (const entry of SCAN_ENTRIES) {
  const before = files.length;
  collectMarkdownFiles(resolve(ROOT, entry), files);
  if (files.length === before && !jsonOutput) {
    console.error(`link-check: warning: scan entry not found: ${entry}`);
  }
}
for (const entry of OPTIONAL_SCAN_ENTRIES) {
  collectMarkdownFiles(resolve(ROOT, entry), files);
}
const markdownFiles = [...new Set(files)].sort((left, right) =>
  toRepoPath(left).localeCompare(toRepoPath(right)),
);

const anchorCache = new Map();
const errors = [];
const totals = { links: 0, external: 0, anchors: 0 };
for (const file of markdownFiles) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    errors.push({
      file: toRepoPath(file),
      line: 0,
      column: 0,
      target: '',
      reason: 'unreadable file',
      detail: error instanceof Error ? error.message : String(error),
    });
    continue;
  }
  const lineStarts = splitLines(text).map((line) => line.start);
  const masked = maskDocument(text, { inlineCode: true });
  const referenceDefinitions = collectReferenceDefinitions(masked);
  const links = collectLinks(masked, lineStarts, referenceDefinitions);
  for (const link of links) {
    totals.links += 1;
    const outcome = validateTarget(link, file, anchorCache);
    if (outcome.kind === 'external') {
      totals.external += 1;
      continue;
    }
    if (outcome.kind === 'broken') {
      errors.push({
        file: toRepoPath(file),
        line: link.line + 1,
        column: link.column,
        target: link.target,
        reason: outcome.reason,
        detail: outcome.detail ?? '',
      });
      continue;
    }
    if (link.target.includes('#')) totals.anchors += 1;
  }
}

errors.sort(
  (left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
);

const report = {
  ok: errors.length === 0,
  root: ROOT,
  files: markdownFiles.length,
  links: totals.links,
  externalLinks: totals.external,
  anchors: totals.anchors,
  errors,
  durationMs: Date.now() - startedAt,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`link-check — markdown relative links & anchors (${markdownFiles.length} files)`);
  if (errors.length > 0) {
    console.log('');
    for (const error of errors) {
      const location = `${error.file}:${error.line}:${error.column}`;
      const detail = error.detail === '' ? '' : ` (${error.detail})`;
      console.log(`  ${location}  ${error.target}  -> ${error.reason}${detail}`);
    }
  }
  console.log('');
  if (errors.length === 0) {
    console.log(
      `link-check OK — ${totals.links} link(s) checked ` +
        `(${totals.external} external skipped, ${totals.anchors} anchor(s)) in ${markdownFiles.length} file(s)`,
    );
  } else {
    console.log(
      `link-check FAILED — ${errors.length} broken link(s); ` +
        `${totals.links} link(s) checked (${totals.external} external skipped) in ${markdownFiles.length} file(s)`,
    );
  }
}

if (errors.length > 0) process.exitCode = 1;
