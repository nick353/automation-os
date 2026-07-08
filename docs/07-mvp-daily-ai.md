# MVP Daily AI Demo

`npm run demo:daily-ai` creates a Daily AI style full-flow run:

- source collection
- X publish proof
- LinkedIn publish proof
- engagement proof
- postflight sync proof
- buffer refresh proof
- cleanup proof

It also creates parallel lanes, an approved approval record for the social publish commit, and advisor events. This is a local simulation, not a real post.

The proof gate requires all listed proof types before the run can be called complete.
