import { parseArithmeticExpression } from "./arithmetic.js";
import { hasEmbeddedWordStructure, Lexer } from "./lexer.js";
import { computeEmbeddedWordParts } from "./parts.js";
import { ScriptExpansionImpl } from "./expansion.js";
import { MAX_SYNTAX_NESTING } from "./limits.js";
export function parseArithmeticWithParts(body, offset, source, depth, context, embeddedDepth = depth) {
    if (!hasEmbeddedWordStructure(source, offset, offset + body.length)) {
        return parseArithmeticExpression(body, offset, undefined, depth) ?? undefined;
    }
    const embeddedWords = [];
    const lexer = new Lexer(source, 0, source.length, false, context);
    lexer._nestingDepth = depth;
    const expression = parseArithmeticExpression(body, offset, {
        embeddedWords,
        commandExpansion: (pos, end, text) => new ScriptExpansionImpl("ArithmeticCommandExpansion", pos, end, text, {
            source,
            start: pos + 2,
            end: end - 1,
            depth: depth + 1,
            parenBoundary: true,
            context,
        }),
        findClosingBracket: (start, end) => lexer.findClosingBracket(start, end),
        findClosingBrace: (start, end) => lexer.findClosingBrace(start, end),
        findClosingParenthesis: (start, end) => lexer.findClosingParenthesis(start, end),
        findArithmeticExpansionEnd: (start, end) => lexer.findArithmeticExpansionEnd(start, end),
        findArithmeticWordEnd: (start, end) => lexer.findArithmeticWordEnd(start, end),
    }, depth) ?? undefined;
    // Past the nesting budget an embedded word keeps its text without parts.
    if (embeddedDepth <= MAX_SYNTAX_NESTING) {
        for (const node of embeddedWords)
            node.parts = computeEmbeddedWordParts(source, node, embeddedDepth, context, true);
    }
    return expression;
}
