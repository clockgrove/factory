export { forEachChild } from "./traversal.js";
import { LexContext, Token, Lexer, TokenValue } from "./lexer.js";
import { MAX_SYNTAX_NESTING } from "./limits.js";
import { parseArithmeticWithParts } from "./arithmetic-parts.js";
import { computeBareWordParts, wordPartsResolver, embeddedPartsResolver } from "./parts.js";
import { createSubstitutionContext, substitutionBoundaries } from "./substitution-context.js";
import { WordImpl } from "./word.js";
import { AssignmentImpl } from "./assignment.js";
import { CommandImpl } from "./command.js";
import { HereDocBodyImpl } from "./heredoc.js";
import { ArithmeticExpansionImpl, ScriptExpansionImpl } from "./expansion.js";
Lexer._findSubstitutionEnd = findSubstitutionEnd;
ScriptExpansionImpl._resolveScript = parseRegion;
ArithmeticExpansionImpl._resolveExpression = parseArithmeticWithParts;
function isDeclarationCommand(name) {
    switch (name.length) {
        case 5:
            return name === "local" || name === "alias";
        case 6:
            return name === "export";
        case 7:
            return name === "declare" || name === "typeset";
        case 8:
            return name === "readonly";
        default:
            return false;
    }
}
class ArithmeticCommandImpl {
    type = "ArithmeticCommand";
    pos;
    end;
    body;
    #source;
    #depth;
    #context;
    #expression = null;
    constructor(pos, end, body, source, depth, context) {
        this.pos = pos;
        this.end = end;
        this.body = body;
        this.#source = source;
        this.#depth = depth;
        this.#context = context;
    }
    get expression() {
        if (this.#expression === null) {
            this.#expression = parseArithmeticWithParts(this.body, this.pos + 2, this.#source, this.#depth, this.#context);
        }
        return this.#expression;
    }
    set expression(v) {
        this.#expression = v ?? undefined;
    }
    toJSON() {
        return {
            type: this.type,
            pos: this.pos,
            end: this.end,
            expression: this.expression,
            body: this.body,
        };
    }
}
class ArithmeticForImpl {
    type = "ArithmeticFor";
    pos;
    end;
    body;
    #initStr;
    #testStr;
    #updateStr;
    #initPos;
    #testPos;
    #updatePos;
    #source;
    #depth;
    #context;
    #initialize = null;
    #test = null;
    #update = null;
    constructor(pos, end, body, initStr, testStr, updateStr, initPos, testPos, updatePos, source, depth, context) {
        this.pos = pos;
        this.end = end;
        this.body = body;
        this.#initStr = initStr;
        this.#testStr = testStr;
        this.#updateStr = updateStr;
        this.#initPos = initPos;
        this.#testPos = testPos;
        this.#updatePos = updatePos;
        this.#source = source;
        this.#depth = depth;
        this.#context = context;
    }
    get initialize() {
        if (this.#initialize === null) {
            if (this.#initStr) {
                this.#initialize = parseArithmeticWithParts(this.#initStr, this.#initPos, this.#source, this.#depth, this.#context);
            }
            else {
                this.#initialize = undefined;
            }
        }
        return this.#initialize;
    }
    set initialize(v) {
        this.#initialize = v ?? undefined;
    }
    get test() {
        if (this.#test === null) {
            if (this.#testStr) {
                this.#test = parseArithmeticWithParts(this.#testStr, this.#testPos, this.#source, this.#depth, this.#context);
            }
            else {
                this.#test = undefined;
            }
        }
        return this.#test;
    }
    set test(v) {
        this.#test = v ?? undefined;
    }
    get update() {
        if (this.#update === null) {
            if (this.#updateStr) {
                this.#update = parseArithmeticWithParts(this.#updateStr, this.#updatePos, this.#source, this.#depth, this.#context);
            }
            else {
                this.#update = undefined;
            }
        }
        return this.#update;
    }
    set update(v) {
        this.#update = v ?? undefined;
    }
    toJSON() {
        return {
            type: this.type,
            pos: this.pos,
            end: this.end,
            initialize: this.initialize,
            test: this.test,
            update: this.update,
            body: this.body,
        };
    }
}
const CASE_TERMINATORS = {
    [Token.DoubleSemi]: ";;",
    [Token.SemiAmp]: ";&",
    [Token.DoubleSemiAmp]: ";;&",
};
const REDIRECT_OPS = {
    ">": ">",
    ">>": ">>",
    "<": "<",
    "<>": "<>",
    "<&": "<&",
    ">&": ">&",
    ">|": ">|",
    "&>": "&>",
    "&>>": "&>>",
};
// Lookup tables for O(1) token classification (replaces sequential comparisons)
const listTerminators = new Uint8Array(37);
listTerminators[Token.EOF] = 1;
listTerminators[Token.RParen] = 1;
listTerminators[Token.RBrace] = 1;
listTerminators[Token.Then] = 1;
listTerminators[Token.Else] = 1;
listTerminators[Token.Elif] = 1;
listTerminators[Token.Fi] = 1;
listTerminators[Token.Do] = 1;
listTerminators[Token.Done] = 1;
listTerminators[Token.Esac] = 1;
listTerminators[Token.DoubleSemi] = 1;
listTerminators[Token.SemiAmp] = 1;
listTerminators[Token.DoubleSemiAmp] = 1;
// After one of these Bash is at a command-start position, the only place a reserved-word
// terminator may follow with no separator.
const compoundClosers = new Uint8Array(37);
compoundClosers[Token.RParen] = 1;
compoundClosers[Token.RBrace] = 1;
compoundClosers[Token.DblRBracket] = 1;
compoundClosers[Token.Fi] = 1;
compoundClosers[Token.Done] = 1;
compoundClosers[Token.Esac] = 1;
compoundClosers[Token.ArithCmd] = 1;
// Inside `[[ ]]` only an unquoted `!` negates; `'!'` and `\!` are ordinary operands.
function isTestNegation(t) {
    return t.token === Token.Word && t.keywordEligible && t.value === "!";
}
const commandStarts = new Uint8Array(37);
commandStarts[Token.Word] = 1;
commandStarts[Token.Assignment] = 1;
commandStarts[Token.Bang] = 1;
commandStarts[Token.LParen] = 1;
commandStarts[Token.LBrace] = 1;
commandStarts[Token.DblLBracket] = 1;
commandStarts[Token.If] = 1;
commandStarts[Token.For] = 1;
commandStarts[Token.While] = 1;
commandStarts[Token.Until] = 1;
commandStarts[Token.Case] = 1;
commandStarts[Token.Function] = 1;
commandStarts[Token.Select] = 1;
commandStarts[Token.ArithCmd] = 1;
commandStarts[Token.Coproc] = 1;
commandStarts[Token.Redirect] = 1;
const UNARY_TEST_OPS = {
    "-a": 1,
    "-b": 1,
    "-c": 1,
    "-d": 1,
    "-e": 1,
    "-f": 1,
    "-g": 1,
    "-h": 1,
    "-k": 1,
    "-p": 1,
    "-r": 1,
    "-s": 1,
    "-t": 1,
    "-u": 1,
    "-v": 1,
    "-w": 1,
    "-x": 1,
    "-z": 1,
    "-n": 1,
    "-o": 1,
    "-N": 1,
    "-S": 1,
    "-L": 1,
    "-G": 1,
    "-O": 1,
    "-R": 1,
};
const BINARY_TEST_OPS = {
    "==": 1,
    "!=": 1,
    "=~": 1,
    "=": 1,
    "-eq": 1,
    "-ne": 1,
    "-lt": 1,
    "-le": 1,
    "-gt": 1,
    "-ge": 1,
    "-nt": 1,
    "-ot": 1,
    "-ef": 1,
    "<": 1,
    ">": 1,
};
const EMPTY_REDIRECTS = [];
const EMPTY_PREFIXES = [];
const EMPTY_ELIFS = [];
export function parse(source) {
    return new Parser(source, 0, source.length).run();
}
// Parse a [start, end) window of `source` in place, so the resulting nodes index the original
// source directly. Used to resolve substitution scripts with absolute offsets; not public API.
export function parseRegion(source, start, end, depth = 0, parenBoundary = false, context) {
    return new Parser(source, start, end, depth, parenBoundary, undefined, context).run();
}
class SubstitutionLexer extends Lexer {
    boundaries;
    pending;
    context;
    constructor(source, boundary, boundaries, pending, context, parenBoundary = true) {
        super(source, boundary.start, boundary.end, parenBoundary, context);
        this._nestingDepth = boundary.depth;
        this.boundaries = boundaries;
        this.pending = pending;
        this.context = context;
    }
    // Keep child boundary requests on this worklist so nested scans stay iterative.
    fork(start, end, parenBoundary = false) {
        return new SubstitutionLexer(this.getSource(), { start, end, depth: this._nestingDepth }, this.boundaries, this.pending, this.context, parenBoundary);
    }
    findSubstitutionEnd(start, end, depth = this._nestingDepth + 1) {
        const known = this.context.boundaries?.get(start);
        if (known !== undefined)
            return known <= end ? known : -1;
        const boundary = this.boundaries.get(start);
        if (boundary !== undefined)
            return boundary <= end ? boundary : -1;
        if (!this.boundaries.has(start)) {
            this.boundaries.set(start, undefined);
            this.pending.push({ start, end, depth });
        }
        return -1;
    }
}
function findSubstitutionEnd(source, start, end, depth, context) {
    const boundaries = new Map([[start, undefined]]);
    const pending = [{ start, end, depth }];
    // Resolve nested requests before retrying their enclosing boundary, without growing the JavaScript stack.
    while (pending.length > 0) {
        const count = pending.length;
        const boundary = pending[count - 1];
        const lexer = new SubstitutionLexer(source, boundary, boundaries, pending, context);
        const found = new Parser(source, boundary.start, boundary.end, boundary.depth, true, lexer).findSubstitutionEnd();
        if (pending.length === count) {
            boundaries.set(boundary.start, found);
            if (found !== -1)
                substitutionBoundaries(context).set(boundary.start, found);
            pending.pop();
        }
    }
    return boundaries.get(start) ?? -1;
}
class Parser {
    tok;
    source;
    start;
    end;
    depth;
    errors = null;
    syntaxDepth = 0;
    // `depth` counts the substitution scripts (and sub-fields) enclosing this region; it
    // shares the MAX_SYNTAX_NESTING budget with the lexer's lazy word-part materialization.
    constructor(source, start, end, depth = 0, parenBoundary = false, lexer, context) {
        this.tok = lexer ?? new Lexer(source, start, end, parenBoundary, createSubstitutionContext(context));
        this.tok._nestingDepth = depth;
        this.source = source;
        this.start = start;
        this.end = end;
        this.depth = depth;
    }
    run() {
        const start = this.start;
        if (this.depth > MAX_SYNTAX_NESTING)
            this.error("maximum substitution nesting depth exceeded", start);
        let shebang;
        if (start === 0 && this.source.charCodeAt(0) === 35 && this.source.charCodeAt(1) === 33) {
            const nl = this.source.indexOf("\n");
            shebang = nl === -1 ? this.source : this.source.slice(0, nl);
        }
        const commands = this.list();
        for (;;) {
            const unexpected = this.tok.peek(LexContext.CommandStart);
            if (unexpected.token === Token.EOF)
                break;
            this.unexpectedToken(unexpected);
            // `In` cannot join `listTerminators`: `list()` shares it, and `in` must not terminate a
            // list inside `for`/`case`.
            if (!listTerminators[unexpected.token] && unexpected.token !== Token.In)
                break;
            this.tok.next(LexContext.CommandStart);
            let separator = this.tok.peek(LexContext.CommandStart).token;
            if (separator !== Token.Semi && separator !== Token.Newline && separator !== Token.Amp)
                break;
            while (separator === Token.Semi || separator === Token.Newline || separator === Token.Amp) {
                this.tok.next(LexContext.CommandStart);
                separator = this.tok.peek(LexContext.CommandStart).token;
            }
            const recovered = this.list();
            for (let i = 0; i < recovered.length; i++)
                commands.push(recovered[i]);
        }
        const lexerErrors = this.tok._errors;
        if (lexerErrors !== null && lexerErrors.length > 0) {
            const errors = this.errors ?? (this.errors = []);
            for (let i = 0; i < lexerErrors.length; i++)
                errors.push(lexerErrors[i]);
        }
        if (this.errors !== null && this.errors.length > 1)
            this.errors.sort((a, b) => a.pos - b.pos);
        return { type: "Script", pos: start, end: this.end, shebang, commands, errors: this.errors ?? undefined };
    }
    error(message, pos) {
        (this.errors ?? (this.errors = [])).push({ message, pos });
    }
    unexpectedToken(t) {
        this.error(`unexpected token '${t.token === Token.Newline ? "newline" : t.value}'`, t.pos);
    }
    findSubstitutionEnd() {
        this.list();
        return this.acceptEnd(Token.RParen);
    }
    skipSemi() {
        if (this.tok.peek(LexContext.Normal).token === Token.Semi)
            this.tok.next(LexContext.Normal);
    }
    accept(token, ctx = LexContext.Normal) {
        if (this.tok.peek(ctx).token === token)
            return this.tok.next(ctx);
        return null;
    }
    acceptEnd(token, ctx = LexContext.Normal) {
        if (this.tok.peek(ctx).token === token)
            return this.tok.next(ctx).end;
        return -1;
    }
    skipNewlines(ctx = LexContext.Normal) {
        while (this.tok.peek(ctx).token === Token.Newline)
            this.tok.next(ctx);
    }
    doBody(hasDo) {
        const body = this.list();
        const emptyPos = hasDo ? this.emptyListPos(body) : -1;
        if (emptyPos >= 0)
            this.error("expected command after 'do'", emptyPos);
        return body;
    }
    // Where an empty compound list stopped, or -1. An empty condition is reported only
    // once `then` or `do` follows, so a missing keyword is not reported twice.
    emptyListPos(commands) {
        return commands.length === 0 ? this.tok.peek(LexContext.CommandStart).pos : -1;
    }
    makeStatement(command) {
        return {
            type: "Statement",
            pos: command.pos,
            end: command.end,
            command,
            background: undefined,
        };
    }
    // list := and_or ((';' | '&' | NEWLINE) and_or)* [';' | '&' | NEWLINE]
    list() {
        const commands = [];
        this.skipNewlines(LexContext.CommandStart);
        let t = this.tok.peek(LexContext.CommandStart).token;
        if (listTerminators[t] || !commandStarts[t])
            return commands;
        const first = this.andOr();
        if (first)
            commands.push(this.makeStatement(first));
        for (;;) {
            t = this.tok.peekFollow(compoundClosers).token;
            if (t !== Token.Semi && t !== Token.Newline && t !== Token.Amp)
                break;
            const isBackground = t === Token.Amp;
            const sepEnd = this.tok.next(LexContext.Normal).end;
            if (isBackground) {
                const stmt = commands[commands.length - 1];
                stmt.background = true;
                stmt.end = sepEnd;
            }
            this.skipNewlines(LexContext.CommandStart);
            t = this.tok.peek(LexContext.CommandStart).token;
            if (listTerminators[t] || !commandStarts[t])
                break;
            const node = this.andOr();
            if (node)
                commands.push(this.makeStatement(node));
        }
        return commands;
    }
    // and_or := pipeline (('&&' | '||') newlines pipeline)*
    andOr() {
        const first = this.pipeline();
        if (!first)
            return null;
        let t = this.tok.peek(LexContext.Normal).token;
        if (t !== Token.And && t !== Token.Or)
            return first;
        const commands = [first];
        const operators = [];
        do {
            const operatorToken = this.tok.next(LexContext.Normal);
            const operator = operatorToken.token === Token.And ? "&&" : "||";
            this.skipNewlines(LexContext.CommandStart);
            const next = this.pipeline();
            if (!next) {
                this.error(`expected command after '${operator}'`, operatorToken.end);
                break;
            }
            operators.push(operator);
            commands.push(next);
            t = this.tok.peek(LexContext.Normal).token;
        } while (t === Token.And || t === Token.Or);
        return {
            type: "AndOr",
            pos: first.pos,
            end: commands[commands.length - 1].end,
            commands,
            operators,
        };
    }
    withRedirects(command) {
        const redirects = this.collectTrailingRedirects();
        if (redirects.length === 0)
            return command;
        return { type: "Redirected", pos: command.pos, end: redirects[redirects.length - 1].end, command, redirects };
    }
    pipeline() {
        let prefixes;
        for (;;) {
            const token = this.tok.peek(LexContext.CommandStart);
            const isTime = token.token === Token.Word && token.keywordEligible && token.value === "time";
            if (token.token !== Token.Bang && !isTime)
                break;
            const prefix = this.tok.next(LexContext.CommandStart);
            const pos = prefix.pos;
            const keywordEnd = prefix.end;
            let posix;
            let endOfOptions;
            if (isTime) {
                let flag = this.tok.peek(LexContext.CommandStart);
                if (flag.token === Token.Word && flag.keywordEligible && flag.value === "-p") {
                    this.tok.next(LexContext.CommandStart);
                    posix = { pos: flag.pos, end: flag.end };
                    flag = this.tok.peek(LexContext.CommandStart);
                }
                if (flag.token === Token.Word && flag.keywordEligible && flag.value === "--") {
                    this.tok.next(LexContext.CommandStart);
                    endOfOptions = { pos: flag.pos, end: flag.end };
                }
            }
            if (prefixes === undefined)
                prefixes = [];
            prefixes.push(isTime
                ? { type: "Time", pos, end: endOfOptions?.end ?? posix?.end ?? keywordEnd, keywordEnd, posix, endOfOptions }
                : { type: "Negation", pos, end: keywordEnd });
        }
        const command = this.pipelineCommands();
        if (!prefixes)
            return command;
        const pos = prefixes[0].pos;
        if (command?.type === "Pipeline") {
            command.prefixes = prefixes;
            command.pos = pos;
            return command;
        }
        return {
            type: "Pipeline",
            pos,
            end: command ? command.end : prefixes[prefixes.length - 1].end,
            prefixes,
            commands: command ? [command] : [],
            operators: [],
        };
    }
    pipelineCommands() {
        const first = this.command();
        if (!first)
            return null;
        if (this.tok.peek(LexContext.Normal).token !== Token.Pipe)
            return first;
        const commands = [first];
        const operators = [];
        while (this.tok.peek(LexContext.Normal).token === Token.Pipe) {
            const pipeToken = this.tok.next(LexContext.Normal);
            const operator = pipeToken.value === "|&" ? "|&" : "|";
            this.skipNewlines(LexContext.CommandStart);
            const cmd = this.command();
            if (!cmd) {
                this.error(`expected command after '${operator}'`, pipeToken.end);
                break;
            }
            operators.push(operator);
            commands.push(cmd);
        }
        if (commands.length === 1) {
            return commands[0];
        }
        const pipeline = {
            type: "Pipeline",
            pos: first.pos,
            end: commands[commands.length - 1].end,
            prefixes: EMPTY_PREFIXES,
            commands,
            operators,
        };
        return pipeline;
    }
    // command := compound_command | function_def | simple_command
    command() {
        let compound;
        switch (this.tok.peek(LexContext.CommandStart).token) {
            case Token.LParen:
                compound = this.subshell();
                break;
            case Token.LBrace:
                compound = this.braceGroup();
                break;
            case Token.If:
                compound = this.ifClause();
                break;
            case Token.For:
                compound = this.forClause();
                break;
            case Token.While:
                compound = this.whileClause();
                break;
            case Token.Until:
                compound = this.untilClause();
                break;
            case Token.Case:
                compound = this.caseClause();
                break;
            case Token.Function:
                return this.functionDef();
            case Token.Select:
                compound = this.selectClause();
                break;
            case Token.DblLBracket:
                compound = this.testCommand();
                break;
            case Token.ArithCmd:
                compound = this.arithCommand();
                break;
            case Token.Coproc:
                return this.coprocCommand();
            case Token.Word:
            case Token.Assignment:
            case Token.Redirect:
                return this.simpleCommandOrFunction(false);
            default:
                return null;
        }
        return this.withRedirects(compound);
    }
    collectTrailingRedirects() {
        let redirects = EMPTY_REDIRECTS;
        while (this.tok.peekFollow(compoundClosers).token === Token.Redirect) {
            if (redirects === EMPTY_REDIRECTS)
                redirects = [];
            redirects.push(this.readRedirect(LexContext.Normal));
        }
        return redirects;
    }
    // arith_command := (( expr ))
    arithCommand() {
        const tok = this.tok.next(LexContext.CommandStart);
        return new ArithmeticCommandImpl(tok.pos, tok.end, tok.value, this.source, this.depth, this.tok.getSubstitutionContext());
    }
    // coproc := COPROC ([name] compound_command [redirections] | simple_command)
    coprocCommand() {
        const start = this.tok.next(LexContext.CommandStart);
        const pos = start.pos;
        const first = this.tok.peek(LexContext.CommandStart);
        let name;
        // Only a compound command can follow a coprocess name. Decide before parsing
        // a simple command so its assignments and reserved words use the actual name.
        if (first.token === Token.Word) {
            const lookahead = this.tok.fork(first.end, this.end);
            switch (lookahead.peek(LexContext.CommandStart).token) {
                case Token.LParen:
                    // `name ( )` opens a function definition, not a subshell body after a name.
                    lookahead.next(LexContext.CommandStart);
                    if (lookahead.peek(LexContext.Normal).token !== Token.RParen)
                        name = this.readWord(LexContext.CommandStart);
                    break;
                case Token.LBrace:
                case Token.If:
                case Token.For:
                case Token.While:
                case Token.Until:
                case Token.Case:
                case Token.Select:
                case Token.DblLBracket:
                case Token.ArithCmd:
                    name = this.readWord(LexContext.CommandStart);
            }
        }
        const cmd = first.token === Token.Word && name === undefined ? this.simpleCommandOrFunction(true) : this.command();
        if (cmd && cmd.type !== "Function" && cmd.type !== "Coproc") {
            return { type: "Coproc", pos, end: cmd.end, name, body: cmd };
        }
        this.error("expected command after 'coproc'", cmd?.pos ?? start.end);
        const body = cmd
            ? this.makeCompoundList([this.makeStatement(cmd)])
            : { type: "CompoundList", pos: start.end, end: start.end, commands: [] };
        return { type: "Coproc", pos, end: body.end, name, body };
    }
    // subshell := '(' list ')'
    subshell() {
        return this.subshellBody(this.tok.next(LexContext.CommandStart).pos);
    }
    // Continues a subshell whose '(' the caller already consumed.
    subshellBody(pos) {
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error("maximum subshell nesting depth exceeded", pos);
            const closeEnd = this.tok.skipSubshellBody();
            if (closeEnd < 0)
                this.error("expected ')' to close subshell", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return { type: "Subshell", pos, end, body: this.makeCompoundList([]) };
        }
        this.syntaxDepth++;
        const commands = this.list();
        this.syntaxDepth--;
        if (commands.length === 0)
            this.error("expected command in subshell", pos);
        const closeEnd = this.acceptEnd(Token.RParen, LexContext.Normal);
        if (closeEnd < 0)
            this.error("expected ')' to close subshell", this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        return { type: "Subshell", pos, end, body: this.makeCompoundList(commands) };
    }
    // brace_group := '{' list '}'
    braceGroup() {
        const pos = this.tok.next(LexContext.CommandStart).pos;
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error("maximum brace group nesting depth exceeded", pos);
            const closeEnd = this.tok.skipCompoundBody(Token.RBrace);
            if (closeEnd < 0)
                this.error("expected '}' to close brace group", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return { type: "BraceGroup", pos, end, body: this.makeCompoundList([]) };
        }
        this.syntaxDepth++;
        const commands = this.list();
        this.syntaxDepth--;
        if (commands.length === 0)
            this.error("expected command in brace group", pos);
        const closeEnd = this.acceptEnd(Token.RBrace, LexContext.Normal);
        if (closeEnd < 0)
            this.error("expected '}' to close brace group", this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        return { type: "BraceGroup", pos, end, body: this.makeCompoundList(commands) };
    }
    // if_clause := IF list THEN list (ELIF list THEN list)* [ELSE list] FI
    ifClause() {
        const pos = this.tok.next(LexContext.CommandStart).pos;
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error("maximum if nesting depth exceeded", pos);
            const closeEnd = this.tok.skipCompoundBody(Token.Fi);
            if (closeEnd < 0)
                this.error("expected 'fi' to close 'if'", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return {
                type: "If",
                pos,
                end,
                clause: this.makeCompoundList([]),
                then: this.makeCompoundList([]),
                elif: EMPTY_ELIFS,
                else: undefined,
            };
        }
        this.syntaxDepth++;
        let command;
        let branchPos = pos;
        for (;;) {
            const clauseCommands = this.list();
            const emptyClausePos = this.emptyListPos(clauseCommands);
            const clause = this.makeCompoundList(clauseCommands);
            this.skipSemi();
            const thenToken = this.accept(Token.Then, LexContext.CommandStart);
            if (!thenToken)
                this.error("expected 'then'", this.tok.getPos());
            else if (emptyClausePos >= 0)
                this.error(`expected command after '${branchPos === pos ? "if" : "elif"}'`, emptyClausePos);
            const thenCommands = this.list();
            const then_ = this.makeCompoundList(thenCommands);
            if (thenToken && thenCommands.length === 0) {
                this.error("expected command after 'then'", this.tok.peek(LexContext.CommandStart).pos);
                then_.pos = thenToken.end;
                then_.end = thenToken.end;
            }
            if (command) {
                if (command.elif === EMPTY_ELIFS)
                    command.elif = [];
                command.elif.push({
                    type: "Elif",
                    pos: branchPos,
                    end: then_.end,
                    clause,
                    then: then_,
                });
            }
            else {
                command = { type: "If", pos, end: pos, clause, then: then_, elif: EMPTY_ELIFS, else: undefined };
            }
            this.skipSemi();
            const elif = this.accept(Token.Elif, LexContext.CommandStart);
            if (!elif)
                break;
            branchPos = elif.pos;
        }
        if (this.accept(Token.Else, LexContext.CommandStart)) {
            const elseCommands = this.list();
            const emptyElsePos = this.emptyListPos(elseCommands);
            if (emptyElsePos >= 0)
                this.error("expected command after 'else'", emptyElsePos);
            command.else = this.makeCompoundList(elseCommands);
            this.skipSemi();
        }
        const closeEnd = this.acceptEnd(Token.Fi, LexContext.CommandStart);
        if (closeEnd < 0)
            this.error("expected 'fi' to close 'if'", this.tok.getPos());
        command.end = closeEnd >= 0 ? closeEnd : branchPos;
        this.syntaxDepth--;
        return command;
    }
    // for_clause := FOR word [IN word* (';'|NL)] DO list DONE
    //            | FOR '((' expr '))' [';'|NL] DO list DONE
    forClause() {
        const pos = this.tok.next(LexContext.CommandStart).pos;
        if (this.tok.peek(LexContext.Normal).token === Token.LParen) {
            return this.cStyleFor(pos);
        }
        const name = this.readRequiredWord("for");
        let wordlist;
        this.skipNewlines(LexContext.CommandStart);
        if (this.tok.peek(LexContext.CommandStart).token === Token.In) {
            this.tok.next(LexContext.CommandStart);
            wordlist = [];
            while (this.tok.peek(LexContext.Normal).token === Token.Word) {
                wordlist.push(this.readWord(LexContext.Normal));
            }
        }
        this.skipSemi();
        this.skipNewlines(LexContext.CommandStart);
        if (this.tok.peek(LexContext.CommandStart).token === Token.LBrace) {
            const bg = this.braceGroup();
            return { type: "For", pos, end: bg.end, name, wordlist, body: bg.body };
        }
        const hasDo = this.accept(Token.Do, LexContext.CommandStart) !== null;
        if (!hasDo)
            this.error("expected 'do'", this.tok.getPos());
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error("maximum for nesting depth exceeded", pos);
            const closeEnd = this.tok.skipCompoundBody(Token.Done);
            if (closeEnd < 0)
                this.error("expected 'done' to close 'for'", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return { type: "For", pos, end, name, wordlist, body: this.makeCompoundList([]) };
        }
        this.syntaxDepth++;
        const body = this.doBody(hasDo);
        this.syntaxDepth--;
        this.skipSemi();
        const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
        if (closeEnd < 0)
            this.error("expected 'done' to close 'for'", this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        return { type: "For", pos, end, name, wordlist, body: this.makeCompoundList(body) };
    }
    // C-style for: (( expr; expr; expr )) [;|NL] do list done | { list }
    cStyleFor(pos) {
        const [initStr, testStr, updateStr, initPos, testPos, updatePos] = this.tok.readCStyleForExprs();
        if (this.tok.peek(LexContext.CommandStart).token === Token.Semi)
            this.tok.next(LexContext.CommandStart);
        this.skipNewlines(LexContext.CommandStart);
        if (this.tok.peek(LexContext.CommandStart).token === Token.LBrace) {
            const bg = this.braceGroup();
            return new ArithmeticForImpl(pos, bg.end, bg.body, initStr, testStr, updateStr, initPos, testPos, updatePos, this.source, this.depth, this.tok.getSubstitutionContext());
        }
        const hasDo = this.accept(Token.Do, LexContext.CommandStart) !== null;
        if (!hasDo)
            this.error("expected 'do'", this.tok.getPos());
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error("maximum for nesting depth exceeded", pos);
            const closeEnd = this.tok.skipCompoundBody(Token.Done);
            if (closeEnd < 0)
                this.error("expected 'done' to close 'for'", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return new ArithmeticForImpl(pos, end, this.makeCompoundList([]), initStr, testStr, updateStr, initPos, testPos, updatePos, this.source, this.depth, this.tok.getSubstitutionContext());
        }
        this.syntaxDepth++;
        const body = this.doBody(hasDo);
        this.syntaxDepth--;
        const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
        if (closeEnd < 0)
            this.error("expected 'done' to close 'for'", this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        return new ArithmeticForImpl(pos, end, this.makeCompoundList(body), initStr, testStr, updateStr, initPos, testPos, updatePos, this.source, this.depth, this.tok.getSubstitutionContext());
    }
    whileClause() {
        return this.whileOrUntil("while");
    }
    untilClause() {
        return this.whileOrUntil("until");
    }
    whileOrUntil(kind) {
        const pos = this.tok.next(LexContext.CommandStart).pos;
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error(`maximum ${kind} nesting depth exceeded`, pos);
            const closeEnd = this.tok.skipCompoundBody(Token.Done);
            if (closeEnd < 0)
                this.error(`expected 'done' to close '${kind}'`, this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return {
                type: "While",
                pos,
                end,
                kind,
                clause: this.makeCompoundList([]),
                body: this.makeCompoundList([]),
            };
        }
        this.syntaxDepth++;
        const clauseCommands = this.list();
        const emptyClausePos = this.emptyListPos(clauseCommands);
        const clause = this.makeCompoundList(clauseCommands);
        this.skipSemi();
        const hasDo = this.accept(Token.Do, LexContext.CommandStart) !== null;
        if (!hasDo)
            this.error("expected 'do'", this.tok.getPos());
        else if (emptyClausePos >= 0)
            this.error(`expected command after '${kind}'`, emptyClausePos);
        const body = this.doBody(hasDo);
        this.skipSemi();
        const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
        if (closeEnd < 0)
            this.error(`expected 'done' to close '${kind}'`, this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        this.syntaxDepth--;
        return { type: "While", pos, end, kind, clause, body: this.makeCompoundList(body) };
    }
    // case_clause := CASE word IN (pattern) list (;; | ;& | ;;&) ... ESAC
    caseClause() {
        const pos = this.tok.next(LexContext.CommandStart).pos;
        const word = this.readRequiredWord("case");
        this.skipNewlines(LexContext.CommandStart);
        if (!this.accept(Token.In, LexContext.CommandStart))
            this.error("expected 'in' after 'case' word", this.tok.getPos());
        this.skipNewlines(LexContext.CasePattern);
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error("maximum case nesting depth exceeded", pos);
            const closeEnd = this.tok.skipCompoundBody(Token.Esac);
            if (closeEnd < 0)
                this.error("expected 'esac' to close 'case'", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return { type: "Case", pos, end, word, items: [] };
        }
        this.syntaxDepth++;
        const items = [];
        // Report only the first grammar error: recovery below would repeat it.
        let invalid = false;
        let t = this.tok.peek(LexContext.CasePattern).token;
        while (t !== Token.Esac && t !== Token.EOF) {
            const itemPos = this.tok.peek(LexContext.Normal).pos;
            this.accept(Token.LParen, LexContext.Normal);
            // pattern := word ('|' word)*
            const pattern = [];
            let expectWord = true;
            let next = this.tok.peek(LexContext.Normal);
            while (next.token !== Token.RParen && next.token !== Token.EOF) {
                const valid = next.token === (expectWord ? Token.Word : Token.Pipe);
                if (valid)
                    expectWord = !expectWord;
                else if (!invalid) {
                    this.unexpectedToken(next);
                    invalid = true;
                }
                const tok = this.tok.next(LexContext.Normal);
                if (tok.token === Token.Word)
                    pattern.push(this.toWord(tok));
                next = this.tok.peek(LexContext.Normal);
            }
            if (expectWord && next.token === Token.RParen && !invalid) {
                this.unexpectedToken(next);
                invalid = true;
            }
            const rparenEnd = this.acceptEnd(Token.RParen, LexContext.Normal);
            const cmds = this.list();
            // An empty body belongs where commands would start, not wherever the lexer stopped.
            const bodyPos = rparenEnd >= 0 ? rparenEnd : pattern.length > 0 ? pattern[pattern.length - 1].end : itemPos;
            const itemEnd = cmds.length > 0 ? cmds[cmds.length - 1].end : bodyPos;
            const item = {
                type: "CaseItem",
                pos: itemPos,
                end: itemEnd,
                pattern,
                body: cmds.length > 0
                    ? this.makeCompoundList(cmds)
                    : { type: "CompoundList", pos: bodyPos, end: bodyPos, commands: [] },
                terminator: undefined,
            };
            const after = this.tok.peek(LexContext.CommandStart);
            t = after.token;
            if (t === Token.DoubleSemi || t === Token.SemiAmp || t === Token.DoubleSemiAmp) {
                const termTok = this.tok.next(LexContext.CommandStart);
                item.terminator = CASE_TERMINATORS[termTok.token];
                item.end = termTok.end;
            }
            else if (t !== Token.Esac && t !== Token.EOF && !invalid) {
                this.unexpectedToken(after);
                invalid = true;
            }
            items.push(item);
            this.skipNewlines(LexContext.CasePattern);
            t = this.tok.peek(LexContext.CasePattern).token;
        }
        const closeEnd = this.acceptEnd(Token.Esac, LexContext.CommandStart);
        if (closeEnd < 0)
            this.error("expected 'esac' to close 'case'", this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        this.syntaxDepth--;
        return { type: "Case", pos, end, word, items };
    }
    // select_clause := SELECT word [IN word* (';'|NL)] DO list DONE
    selectClause() {
        const pos = this.tok.next(LexContext.CommandStart).pos;
        const name = this.readRequiredWord("select");
        let wordlist;
        this.skipNewlines(LexContext.CommandStart);
        if (this.tok.peek(LexContext.CommandStart).token === Token.In) {
            this.tok.next(LexContext.CommandStart);
            wordlist = [];
            while (this.tok.peek(LexContext.Normal).token === Token.Word) {
                wordlist.push(this.readWord(LexContext.Normal));
            }
        }
        this.skipSemi();
        this.skipNewlines(LexContext.CommandStart);
        if (this.tok.peek(LexContext.CommandStart).token === Token.LBrace) {
            const bg = this.braceGroup();
            return { type: "Select", pos, end: bg.end, name, wordlist, body: bg.body };
        }
        const hasDo = this.accept(Token.Do, LexContext.CommandStart) !== null;
        if (!hasDo)
            this.error("expected 'do'", this.tok.getPos());
        if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
            this.error("maximum select nesting depth exceeded", pos);
            const closeEnd = this.tok.skipCompoundBody(Token.Done);
            if (closeEnd < 0)
                this.error("expected 'done' to close 'select'", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : pos;
            return { type: "Select", pos, end, name, wordlist, body: this.makeCompoundList([]) };
        }
        this.syntaxDepth++;
        const body = this.doBody(hasDo);
        this.syntaxDepth--;
        this.skipSemi();
        const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
        if (closeEnd < 0)
            this.error("expected 'done' to close 'select'", this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        return { type: "Select", pos, end, name, wordlist, body: this.makeCompoundList(body) };
    }
    // test_command := [[ test_expr ]]
    testCommand() {
        const pos = this.tok.next(LexContext.CommandStart).pos; // consume [[
        const expr = this.parseTestOr();
        const closeEnd = this.acceptEnd(Token.DblRBracket, LexContext.TestMode);
        if (closeEnd < 0)
            this.error("expected ']]' to close '[['", this.tok.getPos());
        const end = closeEnd >= 0 ? closeEnd : pos;
        return { type: "TestCommand", pos, end, expression: expr };
    }
    // test_or := test_and ('||' test_and)*
    parseTestOr() {
        const first = this.parseTestAnd();
        if (this.tok.peek(LexContext.TestMode).token !== Token.Or)
            return first;
        const operands = [first];
        do {
            this.tok.next(LexContext.TestMode);
            operands.push(this.parseTestAnd());
        } while (this.tok.peek(LexContext.TestMode).token === Token.Or);
        return {
            type: "TestLogical",
            pos: first.pos,
            end: operands[operands.length - 1].end,
            operator: "||",
            operands,
        };
    }
    // test_and := test_not ('&&' test_not)*
    parseTestAnd() {
        const first = this.parseTestNot();
        if (this.tok.peek(LexContext.TestMode).token !== Token.And)
            return first;
        const operands = [first];
        do {
            this.tok.next(LexContext.TestMode);
            operands.push(this.parseTestNot());
        } while (this.tok.peek(LexContext.TestMode).token === Token.And);
        return {
            type: "TestLogical",
            pos: first.pos,
            end: operands[operands.length - 1].end,
            operator: "&&",
            operands,
        };
    }
    // test_not := '!' test_not | test_primary
    parseTestNot() {
        let t = this.tok.peek(LexContext.TestMode);
        if (!isTestNegation(t))
            return this.parseTestPrimary();
        const negations = [];
        while (isTestNegation(t)) {
            const bang = this.tok.next(LexContext.TestMode);
            negations.push({ type: "Negation", pos: bang.pos, end: bang.end });
            t = this.tok.peek(LexContext.TestMode);
        }
        const operand = this.parseTestPrimary();
        return { type: "TestNot", pos: negations[0].pos, end: operand.end, negations, operand };
    }
    // test_primary := '(' test_or ')' | unary_op word | word binary_op word | word
    parseTestPrimary() {
        // Grouped: ( expr )
        if (this.tok.peek(LexContext.TestMode).token === Token.LParen) {
            const openPos = this.tok.next(LexContext.TestMode).pos;
            if (this.syntaxDepth >= MAX_SYNTAX_NESTING) {
                this.error("maximum test group nesting depth exceeded", openPos);
                const closeEnd = this.tok.skipTestGroup();
                if (closeEnd < 0)
                    this.error("expected ')' to close test group", this.tok.getPos());
                const end = closeEnd >= 0 ? closeEnd : openPos;
                const operand = new WordImpl("", openPos, openPos);
                const expression = {
                    type: "TestUnary",
                    pos: openPos,
                    end: openPos,
                    operator: "-n",
                    operand,
                };
                return { type: "TestGroup", pos: openPos, end, expression };
            }
            this.syntaxDepth++;
            const expr = this.parseTestOr();
            this.syntaxDepth--;
            const closeEnd = this.acceptEnd(Token.RParen, LexContext.TestMode);
            if (closeEnd < 0)
                this.error("expected ')' to close test group", this.tok.getPos());
            const end = closeEnd >= 0 ? closeEnd : openPos;
            return { type: "TestGroup", pos: openPos, end, expression: expr };
        }
        const first = this.tok.next(LexContext.TestMode);
        if (first.token === Token.And || first.token === Token.Or)
            this.unexpectedToken(first);
        const val = first.value;
        const firstPos = first.pos;
        const firstEnd = first.end;
        // Unary test: -op word, recognized only as written. Bash rejects the operator without an
        // operand, so keep the operator and report the missing word instead of demoting it to a string.
        if (first.keywordEligible && UNARY_TEST_OPS[val] === 1) {
            if (this.tok.peek(LexContext.TestMode).token === Token.Word) {
                const operand = this.readTestOperand();
                return {
                    type: "TestUnary",
                    pos: firstPos,
                    end: operand.end,
                    operator: val,
                    operand,
                };
            }
            this.error("expected operand after unary test operator", firstEnd);
            const operand = new WordImpl("", firstEnd, firstEnd);
            return { type: "TestUnary", pos: firstPos, end: firstEnd, operator: val, operand };
        }
        // Check for binary op
        const nt = this.tok.peek(LexContext.TestMode);
        if (nt.token === Token.Word && nt.keywordEligible && BINARY_TEST_OPS[nt.value] === 1) {
            const op = this.tok.next(LexContext.TestMode).value;
            let right;
            if (op === "=~") {
                const token = this.tok.readTestRegexWord();
                right = new WordImpl(this.source.slice(token.pos, token.end), token.pos, token.end, this.source, embeddedPartsResolver(this.tok.getSubstitutionContext()), this.depth);
            }
            else {
                right = this.readTestOperand();
            }
            const left = this.toWordFromPosEnd(first, firstPos, firstEnd);
            return {
                type: "TestBinary",
                pos: firstPos,
                end: right.end,
                operator: op,
                left,
                right,
            };
        }
        // Standalone word (implicit -n test)
        const w = this.toWordFromPosEnd(first, firstPos, firstEnd);
        return { type: "TestUnary", pos: firstPos, end: w.end, operator: "-n", operand: w };
    }
    // Unquoted `<` and `>` are operators in `[[ ]]`, never operands.
    readTestOperand() {
        const t = this.tok.next(LexContext.TestMode);
        if (t.keywordEligible && (t.value === "<" || t.value === ">"))
            this.error(`unexpected argument '${t.value}' to conditional operator`, t.pos);
        return this.toWord(t);
    }
    // function_def with 'function' keyword
    functionDef() {
        const pos = this.tok.next(LexContext.CommandStart).pos;
        const name = this.readWord(LexContext.FunctionName);
        let body;
        if (this.tok.peek(LexContext.CommandStart).token === Token.LParen) {
            const openPos = this.tok.next(LexContext.CommandStart).pos;
            // `(` is the optional empty parameter list only when `)` follows immediately;
            // anything else opens a subshell body, as in `f() ( ... )`.
            if (this.tok.peek(LexContext.CommandStart).token === Token.RParen) {
                this.tok.next(LexContext.CommandStart);
                this.skipNewlines(LexContext.CommandStart);
                body = this.commandAsBody();
            }
            else {
                body = this.withRedirects(this.subshellBody(openPos));
            }
        }
        else {
            this.skipNewlines(LexContext.CommandStart);
            body = this.commandAsBody();
        }
        return { type: "Function", pos, end: body.end, name, body };
    }
    // simple_command or function_def (word '(' ')' body)
    simpleCommandOrFunction(coproc) {
        const prefix = [];
        const cmdPos = this.tok.peek(LexContext.CommandStart).pos;
        let lastEnd = cmdPos;
        // Assignments and redirects interleave freely; after the first element CommandPrefix
        // keeps the following command name from being read as a reserved word.
        let ctx = LexContext.CommandStart;
        for (;;) {
            const t = this.tok.peek(ctx).token;
            if (t === Token.Assignment) {
                const assignment = this.tok.next(ctx);
                lastEnd = assignment.end;
                prefix.push(this.parseAssignment(assignment));
            }
            else if (t === Token.Redirect) {
                const redirect = this.readRedirect(ctx);
                prefix.push(redirect);
                lastEnd = redirect.end;
            }
            else {
                break;
            }
            ctx = LexContext.CommandPrefix;
        }
        if (this.tok.peek(LexContext.Normal).token !== Token.Word) {
            return new CommandImpl(cmdPos, lastEnd, undefined, prefix, []);
        }
        const nameToken = this.tok.next(LexContext.Normal);
        const keyword = nameToken.keywordEligible ? nameToken.value : "";
        const name = this.toWord(nameToken);
        ctx = isDeclarationCommand(keyword)
            ? LexContext.Declaration
            : keyword === "eval" || keyword === "let"
                ? LexContext.EvalArgument
                : LexContext.Normal;
        lastEnd = name.end;
        const suffix = [];
        if (coproc) {
            while (this.tok.peek(LexContext.CommandPrefix).token === Token.Assignment) {
                const token = this.tok.next(LexContext.CommandPrefix);
                const word = ctx === LexContext.Declaration ? this.parseAssignment(token) : this.toWord(token);
                suffix.push(word);
                lastEnd = word.end;
            }
        }
        // Check for function definition: word '(' ')' body
        if (this.tok.peek(ctx).token === Token.LParen && suffix.length === 0) {
            this.tok.next(LexContext.Normal);
            if (this.tok.peek(LexContext.Normal).token === Token.RParen) {
                this.tok.next(LexContext.Normal);
                this.skipNewlines(LexContext.CommandStart);
                const body = this.commandAsBody();
                return {
                    type: "Function",
                    pos: name.pos,
                    end: body.end,
                    name,
                    body,
                };
            }
        }
        // Collect suffix words and redirects
        for (;;) {
            const st = this.tok.peek(ctx).token;
            if (st === Token.Word || st === Token.Assignment) {
                const token = this.tok.next(ctx);
                const w = st === Token.Assignment ? this.parseAssignment(token) : this.toWord(token);
                suffix.push(w);
                lastEnd = w.end;
            }
            else if (st === Token.Redirect) {
                const redirect = this.readRedirect(ctx);
                suffix.push(redirect);
                lastEnd = redirect.end;
            }
            else {
                break;
            }
        }
        return new CommandImpl(cmdPos, lastEnd, name, prefix, suffix);
    }
    readRedirect(ctx) {
        const t = this.tok.next(ctx);
        const tPos = t.pos;
        const tEnd = t.end;
        const descriptor = t.fileDescriptor !== undefined
            ? { type: "FileDescriptor", pos: tPos, end: t.descriptorEnd, value: t.fileDescriptor }
            : t.variableName !== undefined
                ? { type: "FileDescriptorVariable", pos: tPos, end: t.descriptorEnd, name: t.variableName }
                : undefined;
        const hasTarget = t.targetEnd > t.targetPos;
        if (!hasTarget)
            this.error("expected redirect target", t.targetPos);
        if (t.value === "<<" || t.value === "<<-") {
            const r = {
                type: "HereDoc",
                pos: tPos,
                end: tEnd,
                operator: t.value,
                descriptor,
                delimiter: hasTarget
                    ? {
                        type: "HereDocDelimiter",
                        pos: t.targetPos,
                        end: t.targetEnd,
                        text: this.source.slice(t.targetPos, t.targetEnd),
                        value: t.content ?? "",
                        quoted: t.delimiterQuoted,
                    }
                    : undefined,
                body: new HereDocBodyImpl(this.source, tEnd, t.delimiterQuoted, this.depth, this.tok.getSubstitutionContext()),
                closing: undefined,
            };
            if (hasTarget)
                this.tok.registerHereDocTarget(r);
            return r;
        }
        const target = hasTarget
            ? new WordImpl(this.source.slice(t.targetPos, t.targetEnd), t.targetPos, t.targetEnd, this.source, wordPartsResolver(this.tok.getSubstitutionContext()), this.depth)
            : undefined;
        return t.value === "<<<"
            ? { type: "HereString", pos: tPos, end: tEnd, operator: "<<<", descriptor, target }
            : { type: "Redirect", pos: tPos, end: tEnd, operator: REDIRECT_OPS[t.value] ?? ">", descriptor, target };
    }
    commandAsBody() {
        const cmd = this.command();
        if (cmd && cmd.type !== "Command" && cmd.type !== "Function" && cmd.type !== "Coproc")
            return cmd;
        this.error("expected compound command as function body", cmd?.pos ?? this.tok.getPos());
        return this.makeCompoundList(cmd ? [this.makeStatement(cmd)] : []);
    }
    readWord(ctx) {
        return this.toWord(this.tok.next(ctx));
    }
    // A missing word stays empty and leaves its token to the rest of the clause.
    readRequiredWord(keyword) {
        const t = this.tok.peek(LexContext.Normal);
        if (t.token === Token.Word)
            return this.toWord(this.tok.next(LexContext.Normal));
        if (t.token !== Token.EOF)
            this.error(`expected word after '${keyword}'`, t.pos);
        return new WordImpl("", t.pos, t.pos);
    }
    toWord(tok) {
        const text = tok.raw ? tok.value : this.source.slice(tok.pos, tok.end);
        // Raw keyword-eligible words have no quotes or expansions to resolve.
        const source = tok.raw && tok.keywordEligible ? undefined : this.source;
        return new WordImpl(text, tok.pos, tok.end, source, source === undefined ? computeBareWordParts : wordPartsResolver(this.tok.getSubstitutionContext()), this.depth);
    }
    toWordFromPosEnd(tok, pos, end) {
        if (tok.pos === pos && tok.end === end)
            return this.toWord(tok);
        return new WordImpl(this.source.slice(pos, end), pos, end, this.source, wordPartsResolver(this.tok.getSubstitutionContext()), this.depth);
    }
    parseAssignment(token) {
        const text = token.raw ? token.value : this.source.slice(token.pos, token.end);
        return new AssignmentImpl(text, token.pos, token.end, this.source, token.assignmentOperatorPos, this.depth, this.tok.getSubstitutionContext());
    }
    makeCompoundList(commands) {
        const p = this.tok.getPos();
        const pos = commands.length > 0 ? commands[0].pos : p;
        const end = commands.length > 0 ? commands[commands.length - 1].end : p;
        return { type: "CompoundList", pos, end, commands };
    }
}
