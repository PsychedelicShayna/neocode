# Thread titles

Generates thread titles for real thread shapes with the server's NeoPi title generator, then sets each new title against the old one for a blind review.

## Run

```sh
cd evals
node --env-file-if-exists=../.env thread-titles/run.ts --model <native-model-or-role> --out runs/titles
node --env-file-if-exists=../.env thread-titles/run.ts --model <native-model-or-role> --out runs/titles-new --baseline runs/titles/results.json
```

- It uses the selected NeoPi executable and its configured inference credentials. `--binary` selects an executable (default `npi`), and `--profile` selects an `OMP_PROFILE`.
- Use `--case <id>` to run one case before a full comparison. Native inference may incur charges.
- `--initial` titles from the first message only, as a new thread does.
- A run writes `results.json` (titles and latency), `review.json` (titles A and B in random order, with a rubric), and `answer-key.json`. Score `review.json` before you open `answer-key.json`.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, the thread `messages`, the `previousTitle`, and a `rubric` that says what a good title names.
