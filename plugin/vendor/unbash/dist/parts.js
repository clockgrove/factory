import { hasEmbeddedWordStructure, Lexer } from "./lexer.js";
import { createSubstitutionContext } from "./substitution-context.js";
import { hasGlobCharacters, parseGlobParts } from "./glob.js";
export const computeBareWordParts = (_source, word) => hasGlobCharacters(word.text) ? parseGlobParts(word.text, 0, word.text.length, undefined, word.pos) : undefined;
export function wordPartsResolver(context) {
    return (context.wordParts ?? (context.wordParts = (source, word, depth) => computeWordParts(source, word, depth, context)));
}
export function embeddedPartsResolver(context) {
    return (context.embeddedParts ??
        (context.embeddedParts = (source, word, depth) => computeEmbeddedWordParts(source, word, depth, context)));
}
export function arrayPartsResolver(context) {
    return (context.arrayParts ??
        (context.arrayParts = (source, word, depth) => computeArrayElementParts(source, word, depth, context)));
}
/**
 * Compute the structural parts of a word by re-scanning the source.
 * This is the "cold path" — only called when consumers actually need parts.
 *
 * Returns undefined for simple words (no quotes, expansions, or special structure).
 */
export function computeWordParts(source, word, depth = 0, context = createSubstitutionContext()) {
    // Bound the re-lex to the word's span. A word inside a substitution script carries the
    // whole original as its source, so an unbounded scan would overrun the word into an
    // adjacent delimiter (e.g. a backtick or `)` immediately after it). For top-level words
    // word.end is the natural boundary, so the bound is a no-op.
    const lexer = new Lexer(source, word.pos, word.end, false, context);
    lexer._nestingDepth = depth;
    const parts = lexer.buildWordParts(word.pos);
    return parts ?? undefined;
}
/** Compute structural parts for a word-like span that may contain shell operators or whitespace. */
export function computeEmbeddedWordParts(source, word, depth = 0, context, arithmetic = false) {
    if (!hasEmbeddedWordStructure(source, word.pos, word.end))
        return undefined;
    const lexer = new Lexer(source, word.pos, word.end, false, context);
    lexer._nestingDepth = depth;
    const parts = lexer.buildEmbeddedWordParts(word.pos, arithmetic);
    return parts ?? undefined;
}
export function computeArrayElementParts(source, word, depth = 0, context) {
    const lexer = new Lexer(source, word.pos, word.end, false, context);
    lexer._nestingDepth = depth;
    const parts = lexer.buildArrayElementParts(word.pos);
    return parts ?? undefined;
}
/**
 * Compute parts for an unquoted heredoc body.
 * Heredoc bodies use different scanning rules than shell words: newlines are
 * literal and single/double quotes have no special meaning.
 */
export function computeHereDocBodyParts(source, word, depth = 0, context) {
    const lexer = new Lexer(source, word.pos, word.end, false, context);
    lexer._nestingDepth = depth;
    const parts = lexer.buildHereDocParts(word.pos, word.end);
    return parts ?? undefined;
}
