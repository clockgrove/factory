// The window is held only until the script resolves; a part constructed without one has no script.
export class ScriptExpansionImpl {
    static _resolveScript;
    type;
    pos;
    end;
    text;
    #window;
    #script = undefined;
    constructor(type, pos, end, text, window) {
        this.type = type;
        this.pos = pos;
        this.end = end;
        this.text = text;
        this.#window = window;
    }
    get script() {
        const window = this.#window;
        if (window !== undefined) {
            const script = ScriptExpansionImpl._resolveScript(window.source, window.start, window.end, window.depth, window.parenBoundary, window.context);
            if (window.context === undefined)
                script.source = window.source;
            this.script = script;
        }
        return this.#script;
    }
    set script(script) {
        this.#script = script;
        this.#window = undefined;
    }
    toJSON() {
        return { type: this.type, pos: this.pos, end: this.end, text: this.text, script: this.script };
    }
}
export class ProcessSubstitutionImpl extends ScriptExpansionImpl {
    operator;
    constructor(pos, end, text, operator, window) {
        super("ProcessSubstitution", pos, end, text, window);
        this.operator = operator;
    }
    toJSON() {
        return {
            type: this.type,
            pos: this.pos,
            end: this.end,
            text: this.text,
            operator: this.operator,
            script: this.script,
        };
    }
}
export class ArithmeticExpansionImpl {
    static _resolveExpression;
    type = "ArithmeticExpansion";
    pos;
    end;
    text;
    #window;
    #expression = undefined;
    constructor(pos, end, text, window) {
        this.pos = pos;
        this.end = end;
        this.text = text;
        this.#window = window;
    }
    get expression() {
        const window = this.#window;
        if (window !== undefined) {
            this.expression = ArithmeticExpansionImpl._resolveExpression(window.body, window.offset, window.source, window.depth, window.context, window.depth + 1);
        }
        return this.#expression;
    }
    set expression(expression) {
        this.#expression = expression;
        this.#window = undefined;
    }
    toJSON() {
        return { type: this.type, pos: this.pos, end: this.end, text: this.text, expression: this.expression };
    }
}
