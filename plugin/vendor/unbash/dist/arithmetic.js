import { ScriptExpansionImpl } from "./expansion.js";
import { MAX_SYNTAX_NESTING } from "./limits.js";
import { CH_TAB, CH_NL, CH_SPACE, CH_BANG, CH_DOLLAR, CH_PERCENT, CH_AMP, CH_LPAREN, CH_RPAREN, CH_STAR, CH_PLUS, CH_COMMA, CH_DASH, CH_SLASH, CH_0, CH_9, CH_COLON, CH_LT, CH_EQ, CH_GT, CH_QUESTION, CH_A, CH_Z, CH_LBRACKET, CH_RBRACKET, CH_CARET, CH_UNDERSCORE, CH_a, CH_z, CH_LBRACE, CH_RBRACE, CH_PIPE, CH_TILDE, } from "./chars.js";
function opPrec(op) {
    switch (op) {
        case ",":
            return 1;
        case "=":
        case "+=":
        case "-=":
        case "*=":
        case "/=":
        case "%=":
        case "<<=":
        case ">>=":
        case "&=":
        case "|=":
        case "^=":
            return 2;
        case "||":
            return 4;
        case "&&":
            return 5;
        case "|":
            return 6;
        case "^":
            return 7;
        case "&":
            return 8;
        case "==":
        case "!=":
            return 9;
        case "<":
        case "<=":
        case ">":
        case ">=":
            return 10;
        case "<<":
        case ">>":
            return 11;
        case "+":
        case "-":
            return 12;
        case "*":
        case "/":
        case "%":
            return 13;
        case "**":
            return 14;
        case "?":
            return 3;
        default:
            return -1;
    }
}
function trimEnd(src, start, end) {
    while (end > start) {
        const c = src.charCodeAt(end - 1);
        if (c !== CH_SPACE && c !== CH_TAB && c !== CH_NL)
            break;
        end--;
    }
    return end;
}
function opRightAssoc(op) {
    switch (op) {
        case "=":
        case "+=":
        case "-=":
        case "*=":
        case "/=":
        case "%=":
        case "<<=":
        case ">>=":
        case "&=":
        case "|=":
        case "^=":
        case "**":
            return true;
        default:
            return false;
    }
}
export function parseArithmeticExpression(src, offset = 0, collector, nestingDepth = 0) {
    let pos = 0;
    const len = src.length;
    const initialWordCount = collector?.embeddedWords.length ?? 0;
    function makeWord(start, end, embedded = false) {
        const node = {
            type: "ArithmeticWord",
            pos: start + offset,
            end: end + offset,
            value: src.slice(start, end),
            parts: undefined,
        };
        if (embedded)
            collector?.embeddedWords.push(node);
        return node;
    }
    function skipWS() {
        while (pos < len) {
            const c = src.charCodeAt(pos);
            if (c === CH_SPACE || c === CH_TAB || c === CH_NL)
                pos++;
            else
                break;
        }
    }
    function tryReadBinOp() {
        if (pos >= len)
            return null;
        const c = src.charCodeAt(pos);
        const nc = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
        const nnc = pos + 2 < len ? src.charCodeAt(pos + 2) : 0;
        switch (c) {
            case CH_COMMA:
                pos++;
                return ",";
            case CH_EQ:
                if (nc === CH_EQ) {
                    pos += 2;
                    return "==";
                }
                pos++;
                return "=";
            case CH_BANG:
                if (nc === CH_EQ) {
                    pos += 2;
                    return "!=";
                }
                return null; // unary
            case CH_LT:
                if (nc === CH_LT) {
                    if (nnc === CH_EQ) {
                        pos += 3;
                        return "<<=";
                    }
                    pos += 2;
                    return "<<";
                }
                if (nc === CH_EQ) {
                    pos += 2;
                    return "<=";
                }
                pos++;
                return "<";
            case CH_GT:
                if (nc === CH_GT) {
                    if (nnc === CH_EQ) {
                        pos += 3;
                        return ">>=";
                    }
                    pos += 2;
                    return ">>";
                }
                if (nc === CH_EQ) {
                    pos += 2;
                    return ">=";
                }
                pos++;
                return ">";
            case CH_PLUS:
                if (nc === CH_EQ) {
                    pos += 2;
                    return "+=";
                }
                if (nc === CH_PLUS)
                    return null; // postfix/prefix, not binary
                pos++;
                return "+";
            case CH_DASH:
                if (nc === CH_EQ) {
                    pos += 2;
                    return "-=";
                }
                if (nc === CH_DASH)
                    return null; // postfix/prefix, not binary
                pos++;
                return "-";
            case CH_STAR:
                if (nc === CH_STAR) {
                    pos += 2;
                    return "**";
                }
                if (nc === CH_EQ) {
                    pos += 2;
                    return "*=";
                }
                pos++;
                return "*";
            case CH_SLASH:
                if (nc === CH_EQ) {
                    pos += 2;
                    return "/=";
                }
                pos++;
                return "/";
            case CH_PERCENT:
                if (nc === CH_EQ) {
                    pos += 2;
                    return "%=";
                }
                pos++;
                return "%";
            case CH_PIPE:
                if (nc === CH_PIPE) {
                    pos += 2;
                    return "||";
                }
                if (nc === CH_EQ) {
                    pos += 2;
                    return "|=";
                }
                pos++;
                return "|";
            case CH_AMP:
                if (nc === CH_AMP) {
                    pos += 2;
                    return "&&";
                }
                if (nc === CH_EQ) {
                    pos += 2;
                    return "&=";
                }
                pos++;
                return "&";
            case CH_CARET:
                if (nc === CH_EQ) {
                    pos += 2;
                    return "^=";
                }
                pos++;
                return "^";
            case CH_QUESTION:
                pos++;
                return "?";
            default:
                return null;
        }
    }
    function skipTruncatedUnary() {
        skipWS();
        while (pos < len) {
            const c = src.charCodeAt(pos);
            if (c !== CH_BANG && c !== CH_TILDE && c !== CH_PLUS && c !== CH_DASH)
                break;
            if (src.charCodeAt(pos + 1) === CH_EQ)
                break;
            pos++;
            skipWS();
        }
        if (src.charCodeAt(pos) === CH_LPAREN) {
            let groups = 1;
            pos++;
            while (pos < len && groups > 0) {
                const wordEnd = collector?.findArithmeticWordEnd?.(pos + offset, offset + len) ?? pos + offset;
                if (wordEnd > pos + offset) {
                    pos = wordEnd - offset;
                    continue;
                }
                const c = src.charCodeAt(pos++);
                if (c === CH_LPAREN)
                    groups++;
                else if (c === CH_RPAREN)
                    groups--;
            }
        }
        else if (pos < len && src.charCodeAt(pos) !== CH_RPAREN && src.charCodeAt(pos) !== CH_COLON) {
            parseAtom(0);
        }
        skipWS();
        const c = src.charCodeAt(pos);
        if ((c === CH_PLUS || c === CH_DASH) && src.charCodeAt(pos + 1) === c)
            pos += 2;
    }
    function recoverExpression(minPrec) {
        skipWS();
        const start = pos;
        if (start === len)
            return makeWord(start, start);
        const wordCount = collector?.embeddedWords.length ?? 0;
        let ternaries = 0;
        for (;;) {
            skipTruncatedUnary();
            skipWS();
            if (src.charCodeAt(pos) === CH_COLON && ternaries > 0) {
                ternaries--;
                pos++;
                continue;
            }
            const saved = pos;
            const op = tryReadBinOp();
            if (op === null || (ternaries === 0 && opPrec(op) < minPrec)) {
                pos = saved;
                break;
            }
            if (op === "?")
                ternaries++;
        }
        if (collector)
            collector.embeddedWords.length = wordCount;
        return makeWord(start, trimEnd(src, start, pos));
    }
    function parseBinExpr(minPrec, depth) {
        if (depth > MAX_SYNTAX_NESTING)
            return recoverExpression(minPrec);
        let left = parseUnaryExpr(depth);
        while (true) {
            skipWS();
            if (pos >= len)
                break;
            const saved = pos;
            const op = tryReadBinOp();
            if (!op)
                break;
            // Ternary
            if (op === "?") {
                if (opPrec(op) < minPrec) {
                    pos = saved;
                    break;
                }
                const consequent = parseBinExpr(1, depth + 1);
                skipWS();
                if (pos < len && src.charCodeAt(pos) === CH_COLON)
                    pos++;
                const alternate = parseBinExpr(3, depth + 1);
                left = { type: "ArithmeticTernary", pos: left.pos, end: alternate.end, test: left, consequent, alternate };
                continue;
            }
            const prec = opPrec(op);
            if (prec < minPrec) {
                pos = saved;
                break;
            }
            const nextPrec = opRightAssoc(op) ? prec : prec + 1;
            const right = parseBinExpr(nextPrec, depth + 1);
            left = { type: "ArithmeticBinary", pos: left.pos, end: right.end, operator: op, left, right };
        }
        return left;
    }
    function parseUnaryExpr(depth) {
        skipWS();
        if (depth > MAX_SYNTAX_NESTING)
            return recoverExpression(15);
        if (pos >= len)
            return makeWord(pos, pos);
        const start = pos;
        const c = src.charCodeAt(pos);
        const nc = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
        // Prefix ++ --
        if (c === CH_PLUS && nc === CH_PLUS) {
            pos += 2;
            const operand = parseUnaryExpr(depth + 1);
            return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "++", operand, prefix: true };
        }
        if (c === CH_DASH && nc === CH_DASH) {
            pos += 2;
            const operand = parseUnaryExpr(depth + 1);
            return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "--", operand, prefix: true };
        }
        // Unary ! ~ + -
        if (c === CH_BANG) {
            pos++;
            const operand = parseUnaryExpr(depth + 1);
            return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "!", operand, prefix: true };
        }
        if (c === CH_TILDE) {
            pos++;
            const operand = parseUnaryExpr(depth + 1);
            return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "~", operand, prefix: true };
        }
        if (c === CH_PLUS && nc !== CH_PLUS && nc !== CH_EQ) {
            pos++;
            const operand = parseUnaryExpr(depth + 1);
            return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "+", operand, prefix: true };
        }
        if (c === CH_DASH && nc !== CH_DASH && nc !== CH_EQ) {
            pos++;
            const operand = parseUnaryExpr(depth + 1);
            return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "-", operand, prefix: true };
        }
        return parsePostfixExpr(depth);
    }
    function parsePostfixExpr(depth) {
        const operand = parseAtom(depth);
        skipWS();
        if (pos + 1 < len) {
            const c = src.charCodeAt(pos);
            const nc = src.charCodeAt(pos + 1);
            if (c === CH_PLUS && nc === CH_PLUS) {
                pos += 2;
                return { type: "ArithmeticUnary", pos: operand.pos, end: pos + offset, operator: "++", operand, prefix: false };
            }
            if (c === CH_DASH && nc === CH_DASH) {
                pos += 2;
                return { type: "ArithmeticUnary", pos: operand.pos, end: pos + offset, operator: "--", operand, prefix: false };
            }
        }
        return operand;
    }
    function parseAtom(depth) {
        skipWS();
        if (pos >= len)
            return makeWord(pos, pos);
        const c = src.charCodeAt(pos);
        // Parenthesized expression
        if (c === CH_LPAREN) {
            const start = pos;
            pos++;
            const expr = parseBinExpr(0, depth + 1);
            skipWS();
            if (pos < len && src.charCodeAt(pos) === CH_RPAREN)
                pos++;
            return { type: "ArithmeticGroup", pos: start + offset, end: pos + offset, expression: expr };
        }
        // Dollar expansion
        if (c === CH_DOLLAR) {
            const start = pos;
            const wordCount = collector?.embeddedWords.length ?? 0;
            const atom = readDollarAtom();
            const wordEnd = collector?.findArithmeticWordEnd?.(start + offset, offset + len) ?? pos + offset;
            if (wordEnd > pos + offset) {
                if (collector)
                    collector.embeddedWords.length = wordCount;
                pos = wordEnd - offset;
                return makeWord(start, pos, true);
            }
            return atom;
        }
        if (c === 0x60 /* ` */ || c === 0x22 /* " */ || c === 0x27 /* ' */) {
            const start = pos;
            pos = (collector?.findArithmeticWordEnd?.(start + offset, offset + len) ?? start + offset + 1) - offset;
            return makeWord(start, pos, true);
        }
        // Number or variable name
        const start = pos;
        const wordCount = collector?.embeddedWords.length ?? 0;
        const atom = readWordAtom();
        const wordEnd = collector?.findArithmeticWordEnd?.(start + offset, offset + len) ?? pos + offset;
        if (wordEnd > pos + offset) {
            if (collector)
                collector.embeddedWords.length = wordCount;
            pos = wordEnd - offset;
            return makeWord(start, pos, true);
        }
        return atom;
    }
    function readDollarAtom() {
        const start = pos;
        pos++; // skip $
        if (pos >= len)
            return makeWord(start, pos);
        const c = src.charCodeAt(pos);
        if (c === CH_LPAREN) {
            if (pos + 1 < len && src.charCodeAt(pos + 1) === CH_LPAREN) {
                // $(( nested arithmetic ))
                const expansionEnd = collector?.findArithmeticExpansionEnd(start + offset, offset + len) ?? -1;
                if (expansionEnd !== -1) {
                    pos = expansionEnd - offset;
                }
                else {
                    pos += 2;
                    let depth = 1;
                    while (pos < len && depth > 0) {
                        if (src.charCodeAt(pos) === CH_LPAREN && src.charCodeAt(pos + 1) === CH_LPAREN) {
                            depth++;
                            pos += 2;
                        }
                        else if (src.charCodeAt(pos) === CH_RPAREN && src.charCodeAt(pos + 1) === CH_RPAREN) {
                            depth--;
                            pos += 2;
                        }
                        else {
                            pos++;
                        }
                    }
                }
            }
            else {
                // $( command substitution )
                pos++; // skip (
                const close = collector?.findClosingParenthesis(pos + offset, offset + len) ?? -1;
                if (close !== -1) {
                    pos = close - offset + 1;
                }
                else {
                    let depth = 1;
                    while (pos < len && depth > 0) {
                        const ch = src.charCodeAt(pos++);
                        if (ch === CH_LPAREN)
                            depth++;
                        else if (ch === CH_RPAREN)
                            depth--;
                    }
                }
                const text = src.slice(start, pos);
                return collector
                    ? collector.commandExpansion(start + offset, pos + offset, text)
                    : new ScriptExpansionImpl("ArithmeticCommandExpansion", start + offset, pos + offset, text);
            }
        }
        else if (c === CH_LBRACE) {
            // ${ parameter expansion }
            const close = collector?.findClosingBrace(pos + offset + 1, offset + len) ?? -1;
            if (close !== -1) {
                pos = close - offset + 1;
            }
            else {
                pos++;
                let depth = 1;
                while (pos < len && depth > 0) {
                    const ch = src.charCodeAt(pos++);
                    if (ch === CH_LBRACE)
                        depth++;
                    else if (ch === CH_RBRACE)
                        depth--;
                }
            }
        }
        else {
            // $var
            while (pos < len) {
                const ch = src.charCodeAt(pos);
                if ((ch >= CH_a && ch <= CH_z) ||
                    (ch >= CH_A && ch <= CH_Z) ||
                    (ch >= CH_0 && ch <= CH_9) ||
                    ch === CH_UNDERSCORE)
                    pos++;
                else
                    break;
            }
        }
        return makeWord(start, pos, c === CH_LPAREN || c === CH_LBRACE);
    }
    function readWordAtom() {
        const start = pos;
        while (pos < len) {
            const c = src.charCodeAt(pos);
            if ((c >= CH_0 && c <= CH_9) ||
                (c >= CH_A && c <= CH_Z) ||
                (c >= CH_a && c <= CH_z) ||
                c === CH_UNDERSCORE ||
                c === 35 // # for base-N literals like 2#101
            ) {
                pos++;
            }
            else
                break;
        }
        // Array subscript: var[expr]
        if (pos > start && pos < len && src.charCodeAt(pos) === CH_LBRACKET) {
            const close = collector?.findClosingBracket?.(pos + offset + 1, offset + len) ?? -1;
            if (close !== -1) {
                pos = close - offset + 1;
            }
            else {
                pos++;
                let depth = 1;
                while (pos < len && depth > 0) {
                    const c = src.charCodeAt(pos);
                    if (c === CH_LBRACKET)
                        depth++;
                    else if (c === CH_RBRACKET)
                        depth--;
                    pos++;
                }
            }
            return makeWord(start, pos, true);
        }
        if (pos === start) {
            // Unknown character — advance to prevent infinite loop
            pos++;
            return makeWord(start, pos);
        }
        return makeWord(start, pos);
    }
    skipWS();
    if (pos >= len)
        return null;
    const start = pos;
    const result = parseBinExpr(0, nestingDepth);
    skipWS();
    if (pos < len) {
        // Unparsed tokens remain: a partial tree would silently drop them, so keep the whole body
        // as one word. With embedded structure its parts still expose nested substitutions.
        if (collector)
            collector.embeddedWords.length = initialWordCount;
        return makeWord(start, trimEnd(src, start, len), collector !== undefined);
    }
    return result;
}
