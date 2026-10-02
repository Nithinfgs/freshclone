# Contributing to freshclone

Thanks for helping. The best contributions are **new diagnoses**: a "works on my machine"
cause that freshclone does not yet recognise.

## Setup

This file is checked by freshclone itself in CI, so the commands below are known to work
from a fresh clone.

<!-- freshclone: skip -->
```bash
git clone https://github.com/Nithinfgs/freshclone.git
cd freshclone
```

```bash
npm ci
```

```bash
npm run check
```

`npm run check` runs ESLint, the TypeScript type check (the code is plain JavaScript with
JSDoc types), and the test suite (`node --test`). Node 20 or newer is required, and there
are no runtime dependencies. Please keep it that way.

## Adding a diagnosis

1. Reproduce the failure in a small project (see `test/check.test.js` for how fixtures are made with `makeProject`).
2. Teach `src/diagnose.js` to recognise the error output, and say both *what is wrong* and *how to fix it*.
3. Add a test that fails without your change.

Prefer precise diagnoses over guesses: a message that is sometimes wrong is worse than none.
Check the evidence (the file really is gitignored, the variable really is set) before claiming a cause.

## Project layout

| Path | Role |
|---|---|
| `src/parse.js` | Markdown fences and `freshclone:` directives |
| `src/plan.js` | Which blocks run, and which are skipped as unsafe or placeholders |
| `src/sandbox.js` | Builds the clean room (files, modes, HOME, env) |
| `src/runner.js` | Runs one step, carrying cwd and env to the next |
| `src/diagnose.js` | Turns failures into explanations |
| `src/report/` | Terminal, HTML, JSON and Markdown output |
| `src/demo.js` | The `--demo` before/after project |

## Pull requests

Keep them focused, update `CHANGELOG.md` for user-visible changes, and use conventional
commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). By contributing you agree
that your work is released under the MIT license.
