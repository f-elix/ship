# CodeRabbit fixtures

Comments that CodeRabbit (`coderabbitai[bot]`) posted on pull requests in November 2026, read with `gh api`. File paths and identifiers are replaced with invented ones; the markup is kept byte for byte, so Prettier ignores this folder.

- `inline-comment.md`: the first comment of an inline review thread, as `pulls/<n>/comments` returns its `body`.
- `review-body.md`: a review's `body`, as `pulls/<n>/reviews` returns it, joined from two reviews and trimmed: the "Outside diff range comments" block of one review (its first two of three comments), and the header, "Nitpick comments" section and a shortened "Prompt to fix all issues" block of another. The "Review info" block is left out.
