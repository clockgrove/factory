function dequoteValue(parts) {
    let s = "";
    for (const c of parts)
        s += c.type === "Literal" ? c.value : c.text;
    return s;
}
export function unescapeBareValue(text) {
    const first = text.indexOf("\\");
    if (first === -1)
        return text;
    let s = "";
    let start = 0;
    for (let i = first; i < text.length; i++) {
        if (text.charCodeAt(i) !== 92)
            continue;
        s += text.slice(start, i);
        i++;
        if (i >= text.length) {
            s += "\\";
            start = i;
            break;
        }
        if (text.charCodeAt(i) !== 10)
            s += text[i];
        start = i + 1;
    }
    return s + text.slice(start);
}
function continuedExpansionValue(text) {
    let pos = 1;
    while (text[pos] === "\\" && text[pos + 1] === "\n")
        pos += 2;
    return pos === 1 || text[pos] !== "(" ? text : text[0] + text.slice(pos);
}
export function wordPartsValue(parts) {
    let value = "";
    for (const part of parts) {
        switch (part.type) {
            case "Literal":
            case "Glob":
            case "SingleQuoted":
            case "AnsiCQuoted":
                value += part.value;
                break;
            case "DoubleQuoted":
            case "LocaleString":
                value += dequoteValue(part.parts);
                break;
            case "CommandExpansion":
                value += part.text[0] === "$" ? continuedExpansionValue(part.text) : part.text;
                break;
            case "ExtendedGlob":
                value += continuedExpansionValue(part.text);
                break;
            default:
                value += part.text;
                break;
        }
    }
    return value;
}
