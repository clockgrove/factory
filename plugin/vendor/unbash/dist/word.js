import { unescapeBareValue, wordPartsValue } from "./word-value.js";
export class WordImpl {
    type = "Word";
    text;
    pos;
    end;
    #source;
    #resolver;
    #depth;
    #parts;
    #value = null;
    constructor(text, pos, end, source, resolver, depth = 0) {
        this.text = text;
        this.pos = pos;
        this.end = end;
        this.#source = source;
        this.#resolver = resolver;
        this.#depth = depth;
        this.#parts = resolver === undefined ? undefined : null;
    }
    get value() {
        if (this.#value === null) {
            const parts = this.#source === undefined && this.#parts === null ? undefined : this.parts;
            this.#value = parts ? wordPartsValue(parts) : unescapeBareValue(this.text);
        }
        return this.#value;
    }
    get parts() {
        if (this.#parts === null) {
            this.#parts = this.#resolver?.(this.#source ?? "", this, this.#depth) ?? undefined;
        }
        return this.#parts;
    }
    set parts(v) {
        this.#parts = v ?? undefined;
    }
    toJSON() {
        return { type: this.type, text: this.text, pos: this.pos, end: this.end, parts: this.parts, value: this.value };
    }
}
