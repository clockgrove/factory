export function forEachChild(node, callback) {
    switch (node.type) {
        case "Script":
        case "CompoundList":
        case "AndOr":
            for (const command of node.commands)
                callback(command);
            return;
        case "Statement":
            callback(node.command);
            return;
        case "Command":
            for (const child of node.prefix)
                callback(child);
            if (node.name)
                callback(node.name);
            for (const child of node.suffix)
                callback(child);
            return;
        case "Pipeline":
            for (const prefix of node.prefixes)
                callback(prefix);
            for (const command of node.commands)
                callback(command);
            return;
        case "Redirected":
            callback(node.command);
            for (const redirect of node.redirects)
                callback(redirect);
            return;
        case "If":
            callback(node.clause);
            callback(node.then);
            for (const branch of node.elif)
                callback(branch);
            if (node.else)
                callback(node.else);
            return;
        case "Elif":
            callback(node.clause);
            callback(node.then);
            return;
        case "For":
        case "Select":
            callback(node.name);
            if (node.wordlist)
                for (const word of node.wordlist)
                    callback(word);
            callback(node.body);
            return;
        case "While":
            callback(node.clause);
            callback(node.body);
            return;
        case "Function":
        case "Coproc":
            if (node.name)
                callback(node.name);
            callback(node.body);
            return;
        case "Subshell":
        case "BraceGroup":
            callback(node.body);
            return;
        case "Case":
            callback(node.word);
            for (const item of node.items)
                callback(item);
            return;
        case "CaseItem":
            for (const pattern of node.pattern)
                callback(pattern);
            callback(node.body);
            return;
        case "ArithmeticFor": {
            const initialize = node.initialize;
            if (initialize)
                callback(initialize);
            const test = node.test;
            if (test)
                callback(test);
            const update = node.update;
            if (update)
                callback(update);
            callback(node.body);
            return;
        }
        case "Word":
        case "Glob":
        case "ArithmeticWord":
        case "HereDocBody":
        case "BraceExpansion":
        case "ExtendedGlob": {
            const parts = node.parts;
            if (parts)
                for (const part of parts)
                    callback(part);
            return;
        }
        case "DoubleQuoted":
        case "LocaleString":
            for (const part of node.parts)
                callback(part);
            return;
        case "ParameterExpansion":
            if (node.index)
                callback(node.index);
            if (node.operation)
                callback(node.operation);
            return;
        case "Default":
        case "Remove":
        case "Transform":
            callback(node.operand);
            return;
        case "CaseModification":
            if (node.operand)
                callback(node.operand);
            return;
        case "Replace":
            callback(node.pattern);
            callback(node.replacement);
            return;
        case "Slice":
            callback(node.offset);
            if (node.length)
                callback(node.length);
            return;
        case "Assignment": {
            const index = node.index;
            if (index)
                callback(index);
            callback(node.value);
            return;
        }
        case "ArrayValue":
            for (const element of node.elements)
                callback(element);
            return;
        case "Redirect":
        case "HereString":
            if (node.descriptor)
                callback(node.descriptor);
            if (node.target)
                callback(node.target);
            return;
        case "HereDoc":
            if (node.descriptor)
                callback(node.descriptor);
            if (node.delimiter)
                callback(node.delimiter);
            callback(node.body);
            return;
        case "CommandExpansion":
        case "ProcessSubstitution":
        case "ArithmeticCommandExpansion": {
            const script = node.script;
            if (script)
                callback(script);
            return;
        }
        case "ArithmeticExpansion":
        case "ArithmeticCommand":
        case "ArithmeticGroup":
        case "TestCommand":
        case "TestGroup": {
            const expression = node.expression;
            if (expression)
                callback(expression);
            return;
        }
        case "ArithmeticBinary":
        case "TestBinary":
            callback(node.left);
            callback(node.right);
            return;
        case "ArithmeticUnary":
        case "TestUnary":
            callback(node.operand);
            return;
        case "ArithmeticTernary":
            callback(node.test);
            callback(node.consequent);
            callback(node.alternate);
            return;
        case "TestLogical":
            for (const operand of node.operands)
                callback(operand);
            return;
        case "TestNot":
            for (const negation of node.negations)
                callback(negation);
            callback(node.operand);
            return;
        case "Literal":
        case "SingleQuoted":
        case "AnsiCQuoted":
        case "SimpleExpansion":
        case "Names":
        case "Unknown":
        case "FileDescriptor":
        case "FileDescriptorVariable":
        case "HereDocDelimiter":
        case "Time":
        case "Negation":
            return;
        default: {
            const exhaustive = node;
            throw new TypeError(`Unexpected syntax node: ${exhaustive}`);
        }
    }
}
