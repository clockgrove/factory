const isArgument = (item) => item.type === "Word" || item.type === "Assignment";
export class CommandImpl {
    type = "Command";
    pos;
    end;
    name;
    prefix;
    suffix;
    #args;
    #redirects;
    constructor(pos, end, name, prefix, suffix) {
        this.pos = pos;
        this.end = end;
        this.name = name;
        this.prefix = prefix;
        this.suffix = suffix;
    }
    get args() {
        if (this.#args === undefined) {
            const suffix = this.suffix;
            this.#args = suffix.every(isArgument) ? suffix : suffix.filter(isArgument);
        }
        return this.#args;
    }
    get redirects() {
        if (this.#redirects === undefined) {
            const redirects = [];
            for (const item of this.prefix)
                if (item.type !== "Assignment")
                    redirects.push(item);
            for (const item of this.suffix)
                if (!isArgument(item))
                    redirects.push(item);
            this.#redirects = redirects;
        }
        return this.#redirects;
    }
    toJSON() {
        return { type: this.type, pos: this.pos, end: this.end, name: this.name, prefix: this.prefix, suffix: this.suffix };
    }
}
