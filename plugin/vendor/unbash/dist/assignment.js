import { Lexer, LexContext, Token } from "./lexer.js";
import { skipLineContinuations } from "./chars.js";
import { arrayPartsResolver, computeBareWordParts, embeddedPartsResolver, wordPartsResolver } from "./parts.js";
import { WordImpl } from "./word.js";
class ArrayValueImpl {
    type = "ArrayValue";
    pos;
    end;
    #source;
    #depth;
    #context;
    #elements;
    constructor(source, pos, end, depth, context) {
        this.pos = pos;
        this.end = end;
        this.#source = source;
        this.#depth = depth;
        this.#context = context;
    }
    get elements() {
        if (this.#elements)
            return this.#elements;
        const lexer = new Lexer(this.#source, this.pos + 1, this.end - 1, false, this.#context);
        lexer._nestingDepth = this.#depth;
        const elements = [];
        while (lexer.peek(LexContext.ArrayElement).token !== Token.EOF) {
            const token = lexer.next(LexContext.ArrayElement);
            if (token.token !== Token.Word && token.token !== Token.Assignment)
                continue;
            const text = token.raw ? token.value : this.#source.slice(token.pos, token.end);
            const indexed = text.charCodeAt(0) === 91;
            const context = lexer.getSubstitutionContext();
            const source = !indexed && token.raw && token.keywordEligible ? undefined : this.#source;
            const resolver = source === undefined
                ? computeBareWordParts
                : indexed
                    ? arrayPartsResolver(context)
                    : wordPartsResolver(context);
            elements.push(new WordImpl(text, token.pos, token.end, source, resolver, this.#depth));
        }
        this.#elements = elements;
        return elements;
    }
    toJSON() {
        return { type: this.type, pos: this.pos, end: this.end, elements: this.elements };
    }
}
export class AssignmentImpl {
    type = "Assignment";
    pos;
    end;
    text;
    #source;
    #depth;
    #context;
    #operatorPos;
    #name = null;
    #append;
    #index;
    #value = null;
    constructor(text, pos, end, source, operatorPos, depth, context) {
        this.pos = pos;
        this.end = end;
        this.text = text;
        this.#source = source;
        this.#operatorPos = operatorPos;
        this.#depth = depth;
        this.#context = context;
    }
    get name() {
        return this.#name ?? this.resolveTarget();
    }
    get append() {
        if (this.#name === null)
            this.resolveTarget();
        return this.#append;
    }
    get index() {
        if (this.#name === null)
            this.resolveTarget();
        return this.#index;
    }
    get value() {
        if (this.#value !== null)
            return this.#value;
        const start = this.#operatorPos + 1;
        const arrayStart = skipLineContinuations(this.#source, start, this.end);
        this.#value =
            this.#source.charCodeAt(arrayStart) === 40 && this.#source.charCodeAt(this.end - 1) === 41
                ? new ArrayValueImpl(this.#source, arrayStart, this.end, this.#depth, this.#context)
                : new WordImpl(this.#source.slice(start, this.end), start, this.end, this.#source, wordPartsResolver(this.#context), this.#depth);
        return this.#value;
    }
    resolveTarget() {
        const equal = this.#operatorPos - this.pos;
        let nameEnd = equal;
        let appendPos = equal;
        while (appendPos >= 2 && this.text.charCodeAt(appendPos - 2) === 92 && this.text.charCodeAt(appendPos - 1) === 10)
            appendPos -= 2;
        if (this.text.charCodeAt(appendPos - 1) === 43) {
            this.#append = true;
            nameEnd = appendPos - 1;
        }
        const bracket = this.text.indexOf("[");
        if (bracket > 0 && bracket < nameEnd) {
            const close = this.text.lastIndexOf("]", equal);
            if (close > bracket) {
                const start = this.pos + bracket + 1;
                const end = this.pos + close;
                this.#index = new WordImpl(this.#source.slice(start, end), start, end, this.#source, embeddedPartsResolver(this.#context), this.#depth);
                nameEnd = bracket;
            }
        }
        const name = this.text.slice(0, nameEnd);
        return (this.#name = name.includes("\\\n") ? name.split("\\\n").join("") : name);
    }
    toJSON() {
        return {
            type: this.type,
            pos: this.pos,
            end: this.end,
            text: this.text,
            name: this.name,
            append: this.append,
            index: this.index,
            value: this.value,
        };
    }
}
