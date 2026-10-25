# Drill roadmap

The integration suite drafts Objectives from this file with `factory propose --source drill/ROADMAP.md#Suite roadmap`. Nothing here is built.

## Suite roadmap

- Add `trimStartDrill(s)` in its own file `src/trimStartDrill.js` as a named export, with its own test: it returns `s` without its leading spaces.
- Add `trimBothDrill(s)` in its own file `src/trimBothDrill.js` as a named export, with its own test: it returns `trimStartDrill(s)` without its trailing spaces, importing `trimStartDrill` from `./trimStartDrill.js`, so it comes after the first item.
