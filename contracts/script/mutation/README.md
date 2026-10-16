# Mutation testing

Applies each hand-picked mutant in `mutants.txt` (flipped comparisons, dropped guards, changed rounding) to
`src/`, runs `forge test --fail-fast`, and restores the file. Run from `contracts/`:

```sh
python3 script/mutation/mutate.py            # or FORGE="docker run ... forge" python3 script/mutation/mutate.py
python3 script/mutation/mutate.py --only 3,7 # a subset
```

A killed mutant made at least one test fail; a survivor is a gap in the suite. Each line of `mutants.txt` is
`file | exact original text (unique) | replacement | description`, with `\n` for line breaks.
