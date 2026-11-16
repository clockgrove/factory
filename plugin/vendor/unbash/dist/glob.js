import { unescapeBareValue, wordPartsValue } from "./word-value.js";
import { CH_BACKSLASH, CH_BANG, CH_CARET, CH_COLON, CH_DASH, CH_DOT, CH_EQ, CH_LBRACKET, CH_LPAREN, CH_NL, CH_QUESTION, CH_RBRACKET, CH_STAR, skipLineContinuations, } from "./chars.js";
export function hasGlobCharacters(text) {
    return /[*?[]/.test(text);
}
const bracketSyntax = new Uint8Array(128);
bracketSyntax[CH_BANG] = 1;
bracketSyntax[CH_CARET] = 1;
bracketSyntax[CH_LBRACKET] = 1;
bracketSyntax[CH_RBRACKET] = 1;
bracketSyntax[CH_COLON] = 1;
bracketSyntax[CH_DOT] = 1;
bracketSyntax[CH_EQ] = 1;
bracketSyntax[CH_DASH] = 1;
bracketSyntax[CH_BACKSLASH] = 1;
// Bracket extents follow Bash's matcher (lib/glob/sm_loop.c, BRACKMATCH and PARSE_SUBBRACKET on
// the path where no member matches): `[:name:]` and `[=c=]` end at the first `:]` or `=]` unless a
// raw `]` comes first, `[.sym.]` ends at the first `.]` even past a `]`, a class or equivalence
// never starts a range, and a `-` range end consumes one member, be it an escape, a plain `[` or a
// collating symbol (also behind an escaped `[`). Quoted and expanded parts are single opaque
// members; Bash additionally lets quoted `]`, `:`, `=`, `.` and `[` take part in symbol and range
// scanning after re-escaping them, which this scan leaves out.
function bracketEnds(source, start, end, parts, offset) {
    let close = end - 1;
    while (close > start && source.charCodeAt(close) !== CH_RBRACKET)
        close--;
    if (close === start)
        return null;
    // Tokens: each special character, and runs of plain members (continuations vanish, quoted or
    // expanded parts are plain). Only specials change an extent, so a run acts as one member except
    // as a range end, which consumes just its first member.
    const positions = [];
    const kinds = [];
    const members = [];
    let partIndex = 0;
    let symbols = false;
    for (let pos = start; pos < end; pos++) {
        while (parts && partIndex < parts.length && parts[partIndex].end <= pos + offset)
            partIndex++;
        const part = parts?.[partIndex];
        const tokenPos = pos;
        let kind = 0;
        if (part && part.pos <= pos + offset && part.type !== "Literal") {
            pos = part.end - offset - 1;
        }
        else {
            kind = source.charCodeAt(pos);
            if (kind === CH_BACKSLASH && pos + 1 < end && source.charCodeAt(pos + 1) === CH_NL) {
                pos++;
                continue;
            }
            if (kind >= 128 || !bracketSyntax[kind])
                kind = 0;
        }
        const last = kinds.length - 1;
        if (kind === 0 && last >= 0 && kinds[last] === 0) {
            members[last]++;
            continue;
        }
        if (last >= 0 && kinds[last] === CH_LBRACKET && (kind === CH_COLON || kind === CH_EQ || kind === CH_DOT)) {
            symbols = true;
        }
        positions.push(tokenPos);
        kinds.push(kind);
        members.push(1);
    }
    const count = kinds.length;
    // PARSE_SUBBRACKET memoized per opener: symbolEnd[t] is the token after the `X]` closing the
    // symbol that `[X` opens at token t, or -1. One right-to-left pass tracks the nearest raw `]`
    // and the nearest `:]`, `=]` and `.]` beyond the opener. Escaped characters are separate tokens,
    // so a `\]` still stops a `:` or `=` scan as it does in Bash.
    let symbolEnd;
    if (symbols) {
        symbolEnd = new Int32Array(count).fill(-1);
        let close = -1;
        let colon = -1;
        let eq = -1;
        let dot = -1;
        for (let i = count - 1; i >= 0; i--) {
            // The scan for the opener at i starts two tokens in, so fold token i + 2 in first.
            const kind = kinds[i + 2];
            if (kind === CH_RBRACKET)
                close = i + 2;
            else if (kinds[i + 3] === CH_RBRACKET) {
                if (kind === CH_COLON)
                    colon = i + 2;
                else if (kind === CH_EQ)
                    eq = i + 2;
                else if (kind === CH_DOT)
                    dot = i + 2;
            }
            if (kinds[i] !== CH_LBRACKET)
                continue;
            const type = kinds[i + 1];
            const found = type === CH_COLON ? colon : type === CH_EQ ? eq : type === CH_DOT ? dot : -1;
            if (found !== -1 && (type === CH_DOT || close === -1 || close > found))
                symbolEnd[i] = found + 2;
        }
    }
    const subBracket = (open) => (symbolEnd === undefined ? -1 : symbolEnd[open]);
    // endFrom[t]: the token after the `]` closing a bracket whose next member starts at token t, or
    // -1 when the pattern runs out and the opening `[` stays literal.
    const endFrom = new Int32Array(count + 2).fill(-1);
    const resume = (next, range) => {
        if (next >= count)
            return -1;
        if (range && kinds[next] === CH_DASH && next + 1 < count && kinds[next + 1] !== CH_RBRACKET) {
            let last = next + 1;
            if (kinds[last] === CH_BACKSLASH) {
                if (last + 1 >= count)
                    return -1;
                last++;
            }
            let after = last + 1;
            if (kinds[last] === CH_LBRACKET && kinds[last + 1] === CH_DOT) {
                const symbol = subBracket(last);
                if (symbol !== -1)
                    after = symbol;
            }
            else if (kinds[last] === 0 && members[last] > 1) {
                // The run's later members stay members, and its last one may start the next range.
                return endFrom[last];
            }
            if (after >= count)
                return -1;
            return kinds[after] === CH_RBRACKET ? after + 1 : endFrom[after];
        }
        return kinds[next] === CH_RBRACKET ? next + 1 : endFrom[next];
    };
    for (let t = count - 1; t >= 0; t--) {
        const kind = kinds[t];
        let after = t + 1;
        let range = true;
        if (kind === CH_BACKSLASH) {
            if (t + 1 >= count)
                continue;
            after = t + 2;
        }
        else if (kind === CH_LBRACKET) {
            const type = kinds[t + 1];
            if (type === CH_COLON || type === CH_EQ || type === CH_DOT) {
                const symbol = subBracket(t);
                if (symbol !== -1) {
                    after = symbol;
                    range = type === CH_DOT;
                }
            }
        }
        endFrom[t] = resume(after, range);
    }
    const ends = new Map();
    for (let t = 0; t < count; t++) {
        if (kinds[t] !== CH_LBRACKET)
            continue;
        let first = t + 1;
        if (kinds[first] === CH_BANG || kinds[first] === CH_CARET)
            first++;
        if (first >= count)
            continue;
        const close = kinds[first] === CH_RBRACKET ? resume(first + 1, true) : endFrom[first];
        if (close !== -1)
            ends.set(positions[t], positions[close - 1] + 1);
    }
    return ends;
}
function appendRange(source, start, end, parts, index, offset, result) {
    while (start < end) {
        while (parts && index < parts.length && parts[index].end <= start + offset)
            index++;
        const part = parts?.[index];
        if (part && part.pos === start + offset && part.end <= end + offset) {
            result.push(part);
            start = part.end - offset;
            index++;
            continue;
        }
        const stop = part ? Math.min(end, (part.pos > start + offset ? part.pos : part.end) - offset) : end;
        const text = source.slice(start, stop);
        result.push({ type: "Literal", pos: start + offset, end: stop + offset, text, value: unescapeBareValue(text) });
        start = stop;
    }
    return index;
}
export function parseGlobParts(source, start, end, parts, offset = 0) {
    let result;
    let brackets;
    let partIndex = 0;
    let emittedIndex = 0;
    let literalStart = start;
    for (let pos = start; pos < end; pos++) {
        while (parts && partIndex < parts.length && parts[partIndex].end <= pos + offset)
            partIndex++;
        const part = parts?.[partIndex];
        if (part && part.pos <= pos + offset && part.type !== "Literal") {
            pos = part.end - offset - 1;
            continue;
        }
        const character = source.charCodeAt(pos);
        if (character === CH_BACKSLASH) {
            pos++;
            continue;
        }
        let globEnd;
        if (character === CH_STAR || character === CH_QUESTION) {
            const limit = part ? Math.min(end, part.end - offset) : end;
            // Embedded-word scans can leave extglob operators inside Literal parts.
            const next = skipLineContinuations(source, pos + 1, limit);
            if (next < limit && source.charCodeAt(next) === CH_LPAREN)
                continue;
            globEnd = pos + 1;
            if (character === CH_STAR) {
                while (globEnd < limit && source.charCodeAt(globEnd) === CH_STAR) {
                    const next = skipLineContinuations(source, globEnd + 1, limit);
                    if (next < limit && source.charCodeAt(next) === CH_LPAREN)
                        break;
                    globEnd++;
                }
            }
        }
        else if (character === CH_LBRACKET) {
            if (brackets === undefined)
                brackets = bracketEnds(source, pos, end, parts, offset);
            const close = brackets?.get(pos);
            if (close === undefined)
                continue;
            globEnd = close;
        }
        else {
            continue;
        }
        if (!result)
            result = [];
        emittedIndex = appendRange(source, literalStart, pos, parts, emittedIndex, offset, result);
        const text = source.slice(pos, globEnd);
        let glob;
        if (character === CH_LBRACKET) {
            const interior = [];
            emittedIndex = appendRange(source, pos + 1, globEnd - 1, parts, emittedIndex, offset, interior);
            glob = {
                type: "Glob",
                kind: "bracket",
                pos: pos + offset,
                end: globEnd + offset,
                text,
                value: "[" + wordPartsValue(interior) + "]",
                parts: interior,
            };
        }
        else {
            glob = {
                type: "Glob",
                kind: character === CH_STAR ? "star" : "question",
                pos: pos + offset,
                end: globEnd + offset,
                text,
                value: text,
                parts: undefined,
            };
        }
        result.push(glob);
        literalStart = globEnd;
        pos = globEnd - 1;
    }
    if (!result)
        return parts ?? undefined;
    appendRange(source, literalStart, end, parts, emittedIndex, offset, result);
    return result;
}
