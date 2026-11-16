import { computeHereDocBodyParts } from "./parts.js";
export class HereDocBodyImpl {
    type = "HereDocBody";
    pos;
    end;
    text = "";
    #source;
    #depth;
    #context;
    #parts;
    constructor(source, pos, quoted, depth, context) {
        this.pos = pos;
        this.end = pos;
        this.#source = source;
        this.#depth = depth;
        this.#context = context;
        this.#parts = quoted ? undefined : null;
    }
    get parts() {
        if (this.#parts === null)
            this.#parts = computeHereDocBodyParts(this.#source, this, this.#depth, this.#context);
        return this.#parts;
    }
    toJSON() {
        return { type: this.type, pos: this.pos, end: this.end, text: this.text, parts: this.parts };
    }
}
