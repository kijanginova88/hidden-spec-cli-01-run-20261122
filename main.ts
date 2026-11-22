// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON text-editor tool calls), finds the lines each edit names
// at the first of three matching tiers, and writes every change or none.
// Node standard library only. See SPEC.md for the contract.

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Files and lines (SPEC section 3)
// ---------------------------------------------------------------------------

type FileModel = {
  lines: string[];
  br: string; // "\n" or "\r\n"
  endsWithBreak: boolean;
};

function parseFile(text: string): FileModel {
  if (text === "") return { lines: [], br: "\n", endsWithBreak: false };
  let br = "\n";
  const firstLf = text.indexOf("\n");
  if (firstLf > 0 && text[firstLf - 1] === "\r") br = "\r\n";
  const parts = text.split(br);
  let endsWithBreak = false;
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
    endsWithBreak = true;
  }
  return { lines: parts, br, endsWithBreak };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return "";
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : "");
}

// A patch's lines: split at \n, one trailing \r removed each, without the
// empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function trimSpaces(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function stripBothWs(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

// ---------------------------------------------------------------------------
// Paths (SPEC section 3)
// ---------------------------------------------------------------------------

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5)
// ---------------------------------------------------------------------------

function linesMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

function findOccurrences(
  lines: string[],
  oldLines: string[],
  tier: number,
  from: number,
  eofOnly: boolean,
): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    if (eofOnly && i + oldLines.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!linesMatch(lines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier at which oldLines occurs at least once (from `from`), or null.
function findTier(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = findOccurrences(lines, oldLines, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// One line of the new side of a hunk/chunk/block.
type NewLine = {
  text: string;
  ctx: boolean; // a context line: written as the file's own matched line
  oIndex: number; // index into O when ctx, else -1
};

// Build the replacement lines for an occurrence at `pos` of O in the file.
// Context lines come from the file; other lines are re-indented at tier 2.
function buildNewLines(
  n: NewLine[],
  fileLines: string[],
  pos: number,
  o: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const f = leadingWs(fileLines[pos] !== undefined ? fileLines[pos] : "");
  const p = o.length > 0 ? leadingWs(o[0]) : "";
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[pos + e.oIndex]);
      continue;
    }
    if (tier === 2) {
      const t = e.text;
      if (!/^[ \t]*$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

type Failure = { code: string; path: string };

type Edit = {
  // Every path the edit names, in the order to safety-check them.
  paths: string[];
  // A move edit's (old, new) pair, for the R line in the output.
  move?: { old: string; new: string };
  // Apply to a scratch copy of the tree; null on success, the failure else.
  // A failed edit leaves the scratch tree untouched by the caller.
  apply: (tree: Map<string, string>) => Failure | null;
};

type ParseResult = { edits: Edit[] } | { parseError: number };

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

type BodyItem = {
  kind: "ctx" | "old" | "new" | "marker";
  text: string;
  raw: string; // the patch line, for trailing-empty detection
};

type Hunk = {
  a: number; // the -A number from the header
  body: BodyItem[];
};

function hunkOldNew(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of h.body) {
    if (it.kind === "ctx") {
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oIndex: o.length - 1 });
    } else if (it.kind === "old") {
      o.push(it.text);
    } else if (it.kind === "new") {
      n.push({ text: it.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

// True when a `\` line immediately follows the hunk's last context or `+` line.
function hunkNoBreak(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i].kind === "ctx" || h.body[i].kind === "new") last = i;
  }
  if (last < 0) return false;
  return last + 1 < h.body.length && h.body[last + 1].kind === "marker";
}

function trimHunkTrailingEmpty(h: Hunk): void {
  // "Empty" here is a blank line: empty or only whitespace.
  while (h.body.length > 0 && h.body[h.body.length - 1].raw.trim() === "") {
    h.body.pop();
  }
}

// Apply a section's hunks in order to a file. Null on success.
function applyHunks(
  file: FileModel,
  hunks: Hunk[],
  strict: boolean,
): { ok: true; file: FileModel } | { ok: false; code: string } {
  let lines = file.lines.slice();
  let endsWithBreak = file.endsWithBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkOldNew(h);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      const newLines = n.map((e) => e.text);
      lines.splice(pos, 0, ...newLines);
      if (atEnd) endsWithBreak = !hunkNoBreak(h);
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0, false);
    if (found === null) return { ok: false, code: "no-match" };
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + o.length === lines.length;
    const newLines = buildNewLines(n, lines, best, o, found.tier);
    lines.splice(best, o.length, ...newLines);
    if (runsToEnd) endsWithBreak = !hunkNoBreak(h);
    d += n.length - o.length;
  }
  return { ok: true, file: { lines, br: file.br, endsWithBreak } };
}

type UniSection = {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  pairSet: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  headerDone: boolean;
  hunks: Hunk[];
};

function freshUniSection(): UniSection {
  return {
    pairOld: undefined,
    pairNew: undefined,
    pairSet: false,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFileMode: false,
    deletedFileMode: false,
    headerDone: false,
    hunks: [],
  };
}

// Text after the four characters, up to the first tab, spaces removed.
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf("\t");
  if (tab >= 0) t = t.slice(0, tab);
  return trimSpaces(t);
}

function stripAB(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function pairPaths(
  oldLine: string,
  newLine: string,
): { old: string | null; new: string | null } {
  const o = stripAB(headerPath(oldLine));
  const n = stripAB(headerPath(newLine));
  return { old: o === "/dev/null" ? null : o, new: n === "/dev/null" ? null : n };
}

const HUNK_RE = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function parseUnified(lines: string[], strict: boolean): ParseResult {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHunk: Hunk | null = null;
  let inBody = false;

  function startSection(): UniSection {
    if (cur !== null) sections.push(cur);
    cur = freshUniSection();
    curHunk = null;
    inBody = false;
    return cur;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (inBody && curHunk !== null) {
      const startsSection =
        line.startsWith("diff --git ") ||
        (line.startsWith("--- ") &&
          i + 1 < lines.length &&
          lines[i + 1].startsWith("+++ "));
      const isBody =
        !startsSection &&
        (line === "" ||
          line[0] === " " ||
          line[0] === "-" ||
          line[0] === "+" ||
          line[0] === "\\");
      if (isBody) {
        if (line === "") curHunk.body.push({ kind: "ctx", text: "", raw: line });
        else if (line[0] === " ")
          curHunk.body.push({ kind: "ctx", text: line.slice(1), raw: line });
        else if (line[0] === "-")
          curHunk.body.push({ kind: "old", text: line.slice(1), raw: line });
        else if (line[0] === "+")
          curHunk.body.push({ kind: "new", text: line.slice(1), raw: line });
        else curHunk.body.push({ kind: "marker", text: line.slice(1), raw: line });
        i++;
        continue;
      }
      trimHunkTrailingEmpty(curHunk);
      inBody = false;
      curHunk = null;
      continue; // reprocess this line outside the body
    }

    if (line.startsWith("diff --git ")) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) return { parseError: i + 1 };
      const s = startSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      i++;
      continue;
    }
    if (
      line.startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ")
    ) {
      if (cur !== null && !cur.headerDone && !cur.pairSet) {
        const p = pairPaths(lines[i], lines[i + 1]);
        cur.pairOld = p.old;
        cur.pairNew = p.new;
        cur.pairSet = true;
        i += 2;
        continue;
      }
      const s = startSection();
      const p = pairPaths(lines[i], lines[i + 1]);
      s.pairOld = p.old;
      s.pairNew = p.new;
      s.pairSet = true;
      i += 2;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (cur !== null && !cur.headerDone) return { parseError: i + 2 };
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (m === null) return { parseError: i + 1 };
      if (cur === null) return { parseError: i + 1 };
      cur.headerDone = true;
      curHunk = { a: parseInt(m[1], 10), body: [] };
      cur.hunks.push(curHunk);
      inBody = true;
      i++;
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (line.startsWith("+++ ")) {
        if (!cur.pairSet) {
          const v = stripAB(headerPath(line));
          cur.pairNew = v === "/dev/null" ? null : v;
          cur.pairSet = true;
        }
      } else if (line.startsWith("rename from ")) {
        cur.renameFrom = trimSpaces(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        cur.renameTo = trimSpaces(line.slice("rename to ".length));
      } else if (line === "new file mode" || line.startsWith("new file mode ")) {
        cur.newFileMode = true;
      } else if (
        line === "deleted file mode" ||
        line.startsWith("deleted file mode ")
      ) {
        cur.deletedFileMode = true;
      }
      // index, old mode, new mode, similarity/dissimilarity index, Index:
      // lines and any other line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  if (inBody && curHunk !== null) trimHunkTrailingEmpty(curHunk);
  if (cur !== null) sections.push(cur);

  const edits: Edit[] = [];
  for (const s of sections) {
    let oldP: string | null | undefined =
      s.pairOld !== undefined
        ? s.pairOld
        : s.renameFrom !== undefined
          ? s.renameFrom
          : s.diffOld;
    let newP: string | null | undefined =
      s.pairNew !== undefined
        ? s.pairNew
        : s.renameTo !== undefined
          ? s.renameTo
          : s.diffNew;
    if (oldP === undefined) oldP = null;
    if (newP === undefined) newP = null;

    const isCreation = (oldP === null || s.newFileMode) && newP !== null;
    const isDeletion = !isCreation && (newP === null || s.deletedFileMode);
    const isMove = !isCreation && !isDeletion && oldP !== newP;
    const hunks = s.hunks;

    if (isCreation) {
      const newPath = newP as string;
      edits.push({
        paths: [newPath],
        apply: (tree) => {
          if (tree.has(newPath)) return { code: "exists", path: newPath };
          const plus: string[] = [];
          for (const h of hunks)
            for (const it of h.body)
              if (it.kind === "new") plus.push(it.text);
          let noBreak = false;
          outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
            const h = hunks[hi];
            for (let bi = h.body.length - 1; bi >= 0; bi--) {
              if (h.body[bi].kind === "new") {
                noBreak =
                  bi + 1 < h.body.length && h.body[bi + 1].kind === "marker";
                break outer;
              }
            }
          }
          const content = serializeFile({
            lines: plus,
            br: "\n",
            endsWithBreak: plus.length > 0 ? !noBreak : false,
          });
          tree.set(newPath, content);
          return null;
        },
      });
    } else if (isDeletion) {
      const oldPath = oldP === null ? "" : (oldP as string);
      edits.push({
        paths: [oldPath],
        apply: (tree) => {
          if (oldP === null || !tree.has(oldP))
            return { code: "missing", path: oldPath };
          tree.delete(oldP);
          return null;
        },
      });
    } else if (isMove) {
      const oldPath = oldP as string;
      const newPath = newP as string;
      edits.push({
        paths: [oldPath, newPath],
        move: { old: oldPath, new: newPath },
        apply: (tree) => {
          if (!tree.has(oldPath)) return { code: "missing", path: oldPath };
          if (tree.has(newPath)) return { code: "exists", path: newPath };
          const res = applyHunks(parseFile(tree.get(oldPath) as string), hunks, strict);
          if (!res.ok) return { code: res.code, path: oldPath };
          tree.delete(oldPath);
          tree.set(newPath, serializeFile(res.file));
          return null;
        },
      });
    } else {
      const filePath = oldP === null ? "" : (oldP as string);
      edits.push({
        paths: [filePath],
        apply: (tree) => {
          if (oldP === null || !tree.has(oldP))
            return { code: "missing", path: filePath };
          const res = applyHunks(parseFile(tree.get(oldP) as string), hunks, strict);
          if (!res.ok) return { code: res.code, path: filePath };
          tree.set(oldP, serializeFile(res.file));
          return null;
        },
      });
    }
  }
  if (edits.length === 0) return { parseError: 1 };
  return { edits };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function isSearchMarker(l: string): boolean {
  return stripTrailingWs(l) === "<<<<<<< SEARCH";
}

function isEqMarker(l: string): boolean {
  return stripTrailingWs(l) === "=======";
}

function isReplaceMarker(l: string): boolean {
  return stripTrailingWs(l) === ">>>>>>> REPLACE";
}

function parseSearchReplace(lines: string[], strict: boolean): ParseResult {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearchMarker(lines[i])) {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isEqMarker(lines[j])) {
        eq = j;
        break;
      }
    }
    if (eq < 0) return { parseError: searchLine };
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (isReplaceMarker(lines[j])) {
        end = j;
        break;
      }
    }
    if (end < 0) return { parseError: searchLine };
    let p: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (t.startsWith("```")) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (prevPath === null) return { parseError: searchLine };
      p = prevPath;
    }
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const filePath = p;
    edits.push({
      paths: [filePath],
      apply: (tree) => {
        if (oldLines.length === 0) {
          if (tree.has(filePath)) return { code: "exists", path: filePath };
          tree.set(
            filePath,
            serializeFile({
              lines: newLines.slice(),
              br: "\n",
              endsWithBreak: newLines.length > 0,
            }),
          );
          return null;
        }
        if (!tree.has(filePath)) return { code: "missing", path: filePath };
        const file = parseFile(tree.get(filePath) as string);
        const found = findTier(file.lines, oldLines, strict, 0, false);
        if (found === null) return { code: "no-match", path: filePath };
        if (found.occ.length !== 1) return { code: "ambiguous", path: filePath };
        const pos = found.occ[0];
        const n: NewLine[] = newLines.map((t) => ({
          text: t,
          ctx: false,
          oIndex: -1,
        }));
        const newLs = buildNewLines(n, file.lines, pos, oldLines, found.tier);
        const fileLines = file.lines.slice();
        fileLines.splice(pos, oldLines.length, ...newLs);
        tree.set(
          filePath,
          serializeFile({
            lines: fileLines,
            br: file.br,
            endsWithBreak: file.endsWithBreak,
          }),
        );
        return null;
      },
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) return { parseError: 1 };
  return { edits };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

type V4aChunk = {
  anchor: string; // "" means no anchor
  body: BodyItem[];
  eof: boolean;
};

function v4aChunkOldNew(ch: V4aChunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of ch.body) {
    if (it.kind === "ctx") {
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oIndex: o.length - 1 });
    } else if (it.kind === "old") {
      o.push(it.text);
    } else if (it.kind === "new") {
      n.push({ text: it.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

function findAnchor(
  lines: string[],
  anchor: string,
  strict: boolean,
  from: number,
): number {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < lines.length; i++) {
      if (linesMatch(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

function isV4aSectionStart(l: string): boolean {
  return (
    l.startsWith("*** Add File: ") ||
    l.startsWith("*** Delete File: ") ||
    l.startsWith("*** Update File: ")
  );
}

function parseV4a(lines: string[], strict: boolean): ParseResult {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first < 0) return { parseError: 1 };
  if (lines[first].trim() !== "*** Begin Patch") return { parseError: first + 1 };
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== "*** End Patch")
    return { parseError: lines.length + 1 };

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const filePath = trimSpaces(line.slice("*** Add File: ".length));
      const items: { text: string; blank: boolean }[] = [];
      i++;
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l) || l.trim() === "*** End Patch") break;
        if (l.startsWith("+")) {
          items.push({ text: l.slice(1), blank: false });
          i++;
          continue;
        }
        if (l === "") {
          items.push({ text: "", blank: true });
          i++;
          continue;
        }
        return { parseError: i + 1 };
      }
      while (items.length > 0 && items[items.length - 1].blank) items.pop();
      const fileLines = items.map((x) => x.text);
      edits.push({
        paths: [filePath],
        apply: (tree) => {
          if (tree.has(filePath)) return { code: "exists", path: filePath };
          tree.set(
            filePath,
            serializeFile({
              lines: fileLines,
              br: "\n",
              endsWithBreak: fileLines.length > 0,
            }),
          );
          return null;
        },
      });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const filePath = trimSpaces(line.slice("*** Delete File: ".length));
      i++;
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l) || l.trim() === "*** End Patch") break;
        if (l.trim() === "") {
          i++;
          continue;
        }
        return { parseError: i + 1 };
      }
      edits.push({
        paths: [filePath],
        apply: (tree) => {
          if (!tree.has(filePath)) return { code: "missing", path: filePath };
          tree.delete(filePath);
          return null;
        },
      });
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const updateLineNo = i + 1;
      const filePath = trimSpaces(line.slice("*** Update File: ".length));
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith("*** Move to: ")) {
        moveTo = trimSpaces(lines[i].slice("*** Move to: ".length));
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l) || l.trim() === "*** End Patch") break;
        if (l.startsWith("@@")) {
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          i++;
          continue;
        }
        if (l === "*** End of File") {
          if (cur === null) return { parseError: i + 1 };
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (
          l === "" ||
          l.startsWith(" ") ||
          l.startsWith("-") ||
          l.startsWith("+")
        ) {
          if (cur === null && chunks.length > 0) {
            // A chunk was closed by *** End of File. A blank line here is
            // ignored only when the section ends after it; otherwise it is
            // not a chunk start and not a body line.
            if (l.trim() === "") {
              let j = i;
              while (j < last && lines[j].trim() === "") j++;
              if (
                j >= last ||
                isV4aSectionStart(lines[j]) ||
                lines[j].trim() === "*** End Patch"
              ) {
                i = j;
                continue;
              }
            }
            return { parseError: i + 1 };
          }
          if (cur === null) {
            cur = { anchor: "", body: [], eof: false };
            chunks.push(cur);
          }
          if (l === "") cur.body.push({ kind: "ctx", text: "", raw: l });
          else if (l.startsWith(" "))
            cur.body.push({ kind: "ctx", text: l.slice(1), raw: l });
          else if (l.startsWith("-"))
            cur.body.push({ kind: "old", text: l.slice(1), raw: l });
          else cur.body.push({ kind: "new", text: l.slice(1), raw: l });
          i++;
          continue;
        }
        return { parseError: i + 1 };
      }
      // Blank lines at the end of a section are not part of it: a blank
      // line is empty or only whitespace.
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1].raw.trim() === "") {
          cur.body.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null)
        return { parseError: updateLineNo };
      const newPath = moveTo;
      const edit: Edit = {
        paths:
          newPath === null ? [filePath] : [filePath, newPath],
        apply: (tree) => {
          if (!tree.has(filePath)) return { code: "missing", path: filePath };
          if (newPath !== null && tree.has(newPath))
            return { code: "exists", path: newPath };
          const file = parseFile(tree.get(filePath) as string);
          let fileLines = file.lines.slice();
          let cursor = 0;
          for (const ch of chunks) {
            if (ch.anchor !== "") {
              const a = findAnchor(fileLines, ch.anchor, strict, cursor);
              if (a < 0) return { code: "no-match", path: filePath };
              cursor = a + 1;
            }
            const { o, n } = v4aChunkOldNew(ch);
            if (o.length === 0) {
              const pos = ch.eof ? fileLines.length : cursor;
              const newLines = n.map((e) => e.text);
              fileLines.splice(pos, 0, ...newLines);
              cursor = pos + newLines.length;
            } else {
              const found = findTier(fileLines, o, strict, cursor, ch.eof);
              if (found === null) return { code: "no-match", path: filePath };
              const pos = found.occ[0];
              const newLines = buildNewLines(n, fileLines, pos, o, found.tier);
              fileLines.splice(pos, o.length, ...newLines);
              cursor = pos + newLines.length;
            }
          }
          const content = serializeFile({
            lines: fileLines,
            br: file.br,
            endsWithBreak: file.endsWithBreak,
          });
          if (newPath !== null) {
            tree.delete(filePath);
            tree.set(newPath, content);
          } else {
            tree.set(filePath, content);
          }
          return null;
        },
      };
      if (newPath !== null) edit.move = { old: filePath, new: newPath };
      edits.push(edit);
      continue;
    }
    return { parseError: i + 1 };
  }
  if (edits.length === 0) return { parseError: 1 };
  return { edits };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonElementToEdit(el: unknown): Edit | null {
  if (typeof el !== "object" || el === null || Array.isArray(el)) return null;
  const o = el as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  if (typeof o.command !== "string") return null;
  const filePath = o.path as string;

  if (o.command === "create") {
    if (typeof o.file_text !== "string") return null;
    const text = o.file_text as string;
    return {
      paths: [filePath],
      apply: (tree) => {
        if (tree.has(filePath)) return { code: "exists", path: filePath };
        tree.set(filePath, text);
        return null;
      },
    };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || (o.old_str as string) === "") return null;
    if (o.new_str !== undefined && typeof o.new_str !== "string") return null;
    const oldStr = o.old_str as string;
    const newStr = (o.new_str as string | undefined) ?? "";
    return {
      paths: [filePath],
      apply: (tree) => {
        if (!tree.has(filePath)) return { code: "missing", path: filePath };
        const text = tree.get(filePath) as string;
        const model = parseFile(text);
        let normText = text;
        let oldS = oldStr;
        let newS = newStr;
        if (model.br === "\r\n") {
          normText = text.replace(/\r\n/g, "\n");
          oldS = oldStr.replace(/\r\n/g, "\n");
          newS = newStr.replace(/\r\n/g, "\n");
        }
        let count = 0;
        let first = -1;
        let pos = 0;
        for (;;) {
          const k = normText.indexOf(oldS, pos);
          if (k < 0) break;
          if (first < 0) first = k;
          count++;
          pos = k + 1;
        }
        if (count === 0) return { code: "no-match", path: filePath };
        if (count > 1) return { code: "ambiguous", path: filePath };
        const result =
          normText.slice(0, first) + newS + normText.slice(first + oldS.length);
        tree.set(
          filePath,
          model.br === "\r\n" ? result.replace(/\n/g, "\r\n") : result,
        );
        return null;
      },
    };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number") return null;
    if (!Number.isInteger(o.insert_line as number)) return null;
    if (typeof o.new_str !== "string") return null;
    const insertLine = o.insert_line as number;
    const newStr = o.new_str as string;
    return {
      paths: [filePath],
      apply: (tree) => {
        if (!tree.has(filePath)) return { code: "missing", path: filePath };
        const file = parseFile(tree.get(filePath) as string);
        if (insertLine < 0 || insertLine > file.lines.length)
          return { code: "no-match", path: filePath };
        const ins = splitPatchLines(newStr);
        const fileLines = file.lines.slice();
        fileLines.splice(insertLine, 0, ...ins);
        tree.set(
          filePath,
          serializeFile({
            lines: fileLines,
            br: file.br,
            endsWithBreak: file.endsWithBreak,
          }),
        );
        return null;
      },
    };
  }
  return null;
}

function parseJsonPatch(lines: string[], text: string): ParseResult {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first < 0) return { parseError: 1 };
  if (lines[first].trimStart().startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      return { parseError: first + 1 };
    }
    if (!Array.isArray(arr)) return { parseError: first + 1 };
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = jsonElementToEdit(el);
      if (e === null) return { parseError: first + 1 };
      edits.push(e);
    }
    if (edits.length === 0) return { parseError: 1 };
    return { edits };
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      return { parseError: i + 1 };
    }
    const e = jsonElementToEdit(obj);
    if (e === null) return { parseError: i + 1 };
    edits.push(e);
  }
  if (edits.length === 0) return { parseError: 1 };
  return { edits };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first >= 0) {
    if (lines[first].trim() === "*** Begin Patch") return "v4a";
    const c = lines[first].trimStart()[0];
    if (c === "[" || c === "{") return "json";
  }
  for (const l of lines) {
    if (stripTrailingWs(l) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (
      lines[i].startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ")
    )
      return "unified";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The tree, the run, and the output (SPEC sections 2, 3, 10)
// ---------------------------------------------------------------------------

function loadTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  function walk(dir: string, rel: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const r = rel === "" ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) {
        walk(p, r);
      } else if (e.isFile()) {
        try {
          out.set(r, fs.readFileSync(p, "utf8"));
        } catch {
          // unreadable: leave it out of the tree
        }
      } else if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(p).isFile()) out.set(r, fs.readFileSync(p, "utf8"));
        } catch {
          // ignore
        }
      }
    }
  }
  walk(root, "");
  return out;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

type ChangeLine = { key: string; text: string; kind: string; path: string };

function computeChanges(
  initial: Map<string, string>,
  current: Map<string, string>,
  moves: { old: string; new: string }[],
): ChangeLine[] {
  const out: ChangeLine[] = [];
  const allPaths = new Set<string>([...initial.keys(), ...current.keys()]);
  for (const p of allPaths) {
    const before = initial.has(p) ? (initial.get(p) as string) : null;
    const after = current.has(p) ? (current.get(p) as string) : null;
    if (before === null && after !== null)
      out.push({ key: p, text: "A " + p, kind: "A", path: p });
    else if (before !== null && after === null)
      out.push({ key: p, text: "D " + p, kind: "D", path: p });
    else if (before !== null && after !== null && before !== after)
      out.push({ key: p, text: "M " + p, kind: "M", path: p });
  }
  for (const m of moves) {
    if (!initial.has(m.old) || current.has(m.old)) continue;
    if (initial.has(m.new) || !current.has(m.new)) continue;
    const di = out.findIndex((c) => c.kind === "D" && c.path === m.old);
    const ai = out.findIndex((c) => c.kind === "A" && c.path === m.new);
    if (di < 0 || ai < 0) continue;
    const hi = Math.max(di, ai);
    const lo = Math.min(di, ai);
    out.splice(hi, 1);
    out.splice(lo, 1);
    out.push({
      key: m.new,
      text: "R " + m.old + " -> " + m.new,
      kind: "R",
      path: m.new,
    });
  }
  out.sort((a, b) => compareBytes(a.key, b.key));
  return out;
}

function writeChanges(
  initial: Map<string, string>,
  current: Map<string, string>,
): void {
  const allPaths = new Set<string>([...initial.keys(), ...current.keys()]);
  for (const p of allPaths) {
    const before = initial.has(p) ? (initial.get(p) as string) : null;
    const after = current.has(p) ? (current.get(p) as string) : null;
    if (before === after) continue;
    if (after === null) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone
      }
    } else {
      const dir = path.dirname(p);
      if (dir !== ".") fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, after, "utf8");
    }
  }
}

function fail2(msg: string): number {
  process.stdout.write(msg + "\n");
  return 2;
}

// ---------------------------------------------------------------------------
// Invocation (SPEC section 1)
// ---------------------------------------------------------------------------

function runCli(argv: string[]): number {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positionals: string[] = [];
  let endOpts = false;

  for (const a of argv) {
    if (!endOpts && a === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (seenCheck) return fail2("error: usage");
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === "--strict") {
        if (seenStrict) return fail2("error: usage");
        seenStrict = true;
        strict = true;
        continue;
      }
      if (a.startsWith("--format=")) {
        if (seenFormat) return fail2("error: usage");
        seenFormat = true;
        const v = a.slice("--format=".length);
        if (
          v !== "unified" &&
          v !== "search-replace" &&
          v !== "v4a" &&
          v !== "json" &&
          v !== "auto"
        )
          return fail2("error: usage");
        format = v;
        continue;
      }
      return fail2("error: usage");
    }
    positionals.push(a);
  }
  if (positionals.length > 1) return fail2("error: usage");

  let patchText: string;
  if (positionals.length === 0 || positionals[0] === "-") {
    try {
      patchText = fs.readFileSync(0, "utf8");
    } catch {
      return fail2("error: no-patch");
    }
  } else {
    try {
      patchText = fs.readFileSync(positionals[0], "utf8");
    } catch {
      return fail2("error: no-patch");
    }
  }
  const patchLines = splitPatchLines(patchText);

  let fmtName = format ?? "auto";
  if (fmtName === "auto") {
    const d = detectFormat(patchLines);
    if (d === null) return fail2("error: format");
    fmtName = d;
  }

  let parsed: ParseResult;
  if (fmtName === "unified") parsed = parseUnified(patchLines, strict);
  else if (fmtName === "search-replace")
    parsed = parseSearchReplace(patchLines, strict);
  else if (fmtName === "v4a") parsed = parseV4a(patchLines, strict);
  else parsed = parseJsonPatch(patchLines, patchText);
  if ("parseError" in parsed) return fail2("error: parse " + parsed.parseError);
  const edits = parsed.edits;

  const initial = loadTree(process.cwd());
  let current = new Map(initial);
  const failures: Failure[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const edit of edits) {
    let fail: Failure | null = null;
    for (const p of edit.paths) {
      if (!isSafePath(p)) {
        fail = { code: "unsafe", path: p };
        break;
      }
    }
    if (fail === null) {
      const trial = new Map(current);
      fail = edit.apply(trial);
      if (fail === null) {
        current = trial;
        if (edit.move !== undefined) moves.push(edit.move);
      }
    }
    if (fail !== null) failures.push(fail);
  }

  if (failures.length > 0) {
    let out = "";
    for (const f of failures) out += "error: " + f.code + " " + f.path + "\n";
    out += "failed: " + failures.length + " of " + edits.length + " edits\n";
    process.stdout.write(out);
    return 1;
  }

  const changes = computeChanges(initial, current, moves);
  let out = "";
  for (const c of changes) out += c.text + "\n";
  out +=
    "ok: " +
    changes.length +
    (changes.length === 1 ? " file\n" : " files\n");
  process.stdout.write(out);
  if (!check) writeChanges(initial, current);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// In a trial the kit's runner takes over: it reads the checks from the env,
// runs this program on each one, and posts the results.
if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import("./runner.ts");
  await runTrial(process.env.MAKEFUN_ENV_URL);
  process.exit(0);
} else {
  process.exit(runCli(process.argv.slice(2)));
}
