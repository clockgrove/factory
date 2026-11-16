// A nested script shares its parent's boundary cache, allocated on first use.
export function createSubstitutionContext(parent) {
    const boundaries = parent === undefined ? undefined : substitutionBoundaries(parent);
    return { boundaries, wordParts: undefined, embeddedParts: undefined, arrayParts: undefined };
}
export function substitutionBoundaries(context) {
    return context.boundaries ?? (context.boundaries = new Map());
}
