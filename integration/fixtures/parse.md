# parse(text)

`parse` reads simple `key=value` records, one per line.

- Keys and values are trimmed; values are strings.
- Empty input (an empty string, or only whitespace) is an error: throw a `ParseError`.
- A line without `=` is an error: throw a `ParseError` naming the line number.
- Later keys replace earlier ones.
