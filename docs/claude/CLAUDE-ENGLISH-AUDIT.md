# Auditing the English of Docs and JSDoc: a Hand-off

This hand-off says how to audit the English writing in a code project:
its Markdown docs, such as a README, an architecture doc or an
engineering reference, its command-line help, and its JSDoc, the comment
blocks in JavaScript files that describe a file, a function or a value
in a set form (`@param`, `@returns`, `@throws`). It gives the standard
each text must meet, how to check each text against the code, how to
write a fix, and the loop of fresh readers that checks an audit before
its fixes are made. It comes from audits of the owner's projects, whose
coding standards are those of LP Ranger, his bot that manages his 9mm V3
liquidity positions; where a rule here is that project's own, it says
so.

## Contents

- [1. What an Audit Covers](#1-what-an-audit-covers)
- [2. The Standard Every Text Meets](#2-the-standard-every-text-meets)
  - [Describe the System as It Is](#describe-the-system-as-it-is)
  - [Lead Each Topic With Its Context](#lead-each-topic-with-its-context)
  - [Introduce Each Tool Where It Is First Named](#introduce-each-tool-where-it-is-first-named)
    - [What Counts as a Tool](#what-counts-as-a-tool)
    - [The Four Parts of an Introduction](#the-four-parts-of-an-introduction)
    - [Where an Introduction Must Appear](#where-an-introduction-must-appear)
  - [Facts, Not Adjectives](#facts-not-adjectives)
  - [Leave Out No Step of the Logic](#leave-out-no-step-of-the-logic)
  - [One Word for One Thing](#one-word-for-one-thing)
  - [Say What Can Change a Figure](#say-what-can-change-a-figure)
  - [Name the Clock and the Calendar](#name-the-clock-and-the-calendar)
  - [Quote Outputs Exactly](#quote-outputs-exactly)
  - [Structure and Navigation](#structure-and-navigation)
- [3. JSDoc and Comments](#3-jsdoc-and-comments)
  - [File Headers](#file-headers)
  - [Function Docstrings](#function-docstrings)
  - [Inline Comments](#inline-comments)
  - [Test Titles](#test-titles)
- [4. Checking Every Claim Against the Code](#4-checking-every-claim-against-the-code)
  - [What to Check](#what-to-check)
  - [How to Check It](#how-to-check-it)
  - [Where Docs Most Often Go Wrong](#where-docs-most-often-go-wrong)
  - [Keeping Every Text Saying the Same Thing](#keeping-every-text-saying-the-same-thing)
- [5. Significant and Minor Findings](#5-significant-and-minor-findings)
- [6. Writing a Fix](#6-writing-a-fix)
- [7. The Fresh-Reader Loop](#7-the-fresh-reader-loop)
  - [Why Fresh Readers](#why-fresh-readers)
  - [The Files of the Loop](#the-files-of-the-loop)
  - [The Steps of the Loop](#the-steps-of-the-loop)
  - [The Full-Pass Brief](#the-full-pass-brief)
  - [The Efficient-Pass Brief](#the-efficient-pass-brief)
- [8. Findings From Past Audits, Before and After](#8-findings-from-past-audits-before-and-after)
- [9. Automated Checks Worth Having](#9-automated-checks-worth-having)
- [10. A Checklist for Each Text](#10-a-checklist-for-each-text)

## 1. What an Audit Covers

A doc is read by someone who does not have the code open: a user
deciding how to run a tool, or a developer about to change it. An audit
makes sure that what they read is true of the code as it stands, that a
newcomer can follow it, and that it leaves out no condition that changes
what the code does. It covers every text a reader meets:

- the Markdown docs: the README, and docs such as `docs/architecture.md`
  (how the parts work), `docs/engineering.md` (the files, the checks, the
  tests and CI, the checks run on each push) and a list of every command;
- the help a command line prints for `--help`;
- the JSDoc of each file and function, and the comments in the code;
- the titles of the tests, which say what each test holds the code to;
- any other text the project shows its user, such as a help page built
  from a script's header.

## 2. The Standard Every Text Meets

### Describe the System as It Is

A doc says how the system works now. It tells no story of an old bug or
an old design: no "used to", "previously", "now", "no longer", "was
fixed", "after the change". A reader of the doc needs the rule, not how
the rule came about; the history belongs in commit messages and pull
requests.

- Before: "The lock wait is now 20 seconds; it used to be 120, which
  made cells fail."
- After: "A call that gets no lock within 20 seconds shows the busy
  message, so that it ends within the 30 seconds Google gives a call."

### Lead Each Topic With Its Context

Every topic and sub-topic opens with what a reader needs to follow it:
the situation it is about, and why it matters, before the rule. A
section on a cache first says what is kept and why a reader would care;
a section on a fallback first says what the first source is and when it
fails.

### Introduce Each Tool Where It Is First Named

#### What Counts as a Tool

A tool is anything a reader runs or a program uses: an `npm run`
command, a program in `bin/`, a script, a package, an outside service.
Treat a technical term the same way: an http status, a hash function
such as PBKDF2, an address format such as EIP-55, a "UTC day". A name a
reader has not met is a gap in the text, however familiar it is to the
writer.

#### The Four Parts of an Introduction

1. The big picture: what kind of thing it is.
2. A few words of context, or a scenario in which it is used.
3. Which codebase it comes from: this repo, another of the owner's, or
   an outside party.
4. What it does, in precise words.

For example: "crypto-price-filler, this repo's program run from a
terminal, prices every row of a CSV file at the row's own time, such as
each payout in a year of a miner's payouts, and writes the rows again
with each one's price."

#### Where an Introduction Must Appear

- At the first mention in each doc: a reader may open any doc first.
- At the first mention in each part a reader can see alone, such as each
  section of a help page that shows sections one at a time.
- Before the text uses the name, not after: a rule that names a source
  above the paragraph that introduces it fails, even if the
  introduction is a few lines below.

### Facts, Not Adjectives

Replace each adjective or adverb that stands in for an explanation with
the fact it hides. Words to look for: robust, seamless, powerful,
efficient, simple, simply, just, easily, properly, correctly, gracefully,
"reads right", "works as expected", "best".

- Before: "The tool reads dates correctly across daylight saving."
- After: "Each row's time is read with the offset its time zone had at
  that time, daylight saving included."

Give each number its unit, and the one the code uses: seconds or
milliseconds, days or hours, decimal places.

### Leave Out No Step of the Logic

Every condition that changes the outcome is a turning point, and each
one is in the text: the order in which sources are asked, each fallback,
each case that gives no result, each limit, each skip. For every "when
X, then Y", check what happens when X is not so, and whether the text
says it.

- A list of what a tool does in each case is complete only when every
  branch of the code is in it. Read the branches, then the list.
- A rule with an exception states the exception where the rule is
  stated, not three sections later.
- A sentence that says what happens "with no key saved" must also cover
  the flags that change it, such as a flag that asks for the keyed
  service anyway.

### One Word for One Thing

Name each idea with one word through every text, and use the name the
code uses for a setting, a file or a message. A text that says "period"
in one place and "window" in another makes the reader wonder whether
they are two things. Pick one, and change the other everywhere it
appears in the docs, the help and the JSDoc.

### Say What Can Change a Figure

When a settings file can change a number or a choice the doc states,
say so where the doc states it: "as the script is written", then name
the file and the setting (`QUOTE_CURRENCY` in
`fetch-from-any-exchange/config.json`). Do the same for a default that a
command-line option replaces. Advice that rests on a setting, such as
how long to wait before freezing a value that is cached for 6 hours,
says which setting it rests on.

### Name the Clock and the Calendar

A day, a week or a month in the text is in a time zone, and a week
starts on a day. Say both wherever a reader acts on them: "the UTC day
that holds the time", "the week, which the exchange counts from Monday
00:00 UTC". A reader in another time zone counts a local day; a reader
in the United States counts weeks from Sunday. Either can act too early
on text that leaves the zone or the first day out.

### Quote Outputs Exactly

A message, a column header or a file name the code writes is quoted as
the code writes it, in a code span, with the same capitals, spaces and
punctuation: `Rate limit busy - retry later`, `$usd price`. Where the
message holds a value, quote the fixed part and mark the rest:
`Too recent for a final price: ask again after …`.

### Structure and Navigation

- A long doc opens with a clickable table of contents that goes down at
  least three levels of sub-heading where the doc has them.
- Every heading is unique in its doc, so that each link to it has one
  target; a heading names its topic.
- Every link resolves: to a file the repo keeps, or to a heading that
  exists. A link to a heading uses the heading's anchor as the site
  that shows the doc makes it (on GitHub: lower case, spaces as hyphens,
  punctuation removed).
- A table is used when the reader compares rows; prose when the reader
  follows steps.

## 3. JSDoc and Comments

JSDoc is what a developer reads before changing the code, and it is
held to the same standard as the docs: true of the code, complete at
each turning point, with each name introduced.

### File Headers

The owner's projects open each file with a header in three parts:

- What: what the file does, and the situation it serves.
- How: how it does it, step by step, at the level a reader needs before
  reading the code.
- Fit: which other files use it, and why it is a file of its own.

A header names the codebase a shared module comes from, such as
`crypto-price-fetchers/dex-prices/geckoterminal`, and says where the
rest of the story is told.

### Function Docstrings

- The first sentence says what the function gives or does, in the
  terms of its caller.
- Each `@param` gives the type, the unit, the values it takes, and what
  `null` or a missing value means.
- `@returns` names every case: "the price, or null when the period is
  not over, or no candle holds the time".
- `@throws` says when.
- The docstring matches the order of the code. A docstring that says a
  function "reads the clock once, before it asks for the candles" is
  wrong if the code reads it after the request returns, and the
  difference can decide whether a value from an unfinished period is
  taken.
- A docstring says why a step is there when the code alone does not
  show it, and does not restate the code line by line.

### Inline Comments

- A comment says why, not what; it tells no history.
- It follows the project's own form. LP Ranger's rules, for example,
  write a multi-line comment as a `/*-` … `*/` block with each marker on
  a line of its own, and mark a test's swap of a global with
  `TEST-ONLY global swap:`.
- A comment beside code that the audit changes is read again: a comment
  that described the old behavior is now a wrong fact.

### Test Titles

A test's title is a claim about the code. When a fix changes what a
test expects, the title of the test and of its group are read again: a
group titled "the day asked of the service is the UTC day" is wrong once
its test expects the next UTC day.

## 4. Checking Every Claim Against the Code

### What to Check

Check each of these against the code, not against another doc:

- every number: times, counts, limits, decimal places, retries;
- every name: settings, files, folders, options, environment variables,
  functions, messages;
- the order of steps and of sources;
- each condition, its boundary included: "after" or "at or after", "over"
  or "not over", "less than a day" or "a day or less";
- each default, and where it lives: in the code, in a committed settings
  file, or in a settings file git ignores;
- each path and link.

### How to Check It

1. Read the code path end to end, from the entry point the doc describes
   to the output it names; do not stop at the first function that seems
   to match.
2. For a claim that turns on several branches, write a small script that
   runs the code with a stand-in for each service, and check each case
   the text names. A script worth keeping goes into the tests, so the
   next audit reuses it.
3. Search the whole repo for each fact the audit changes (`git grep`),
   and read every place it appears.
4. Record each fact confirmed, with its file and line, so that the next
   reader can skip it.

### Where Docs Most Often Go Wrong

- Letter case: a column found by `h.includes("date")` misses a header
  `Date (UTC)`, while the doc says "a column whose name holds date".
- Retries: a doc that says "fails every try" when only one status, such
  as 429, is tried again.
- Caches: what is kept, for how long, and what is never kept, such as a
  busy message.
- Defaults: a default described as a setting of a file that does not
  hold it.
- Edge cases of time: a period that ends while a request is in flight;
  a week that ends after its month or its year.
- Fallbacks: the case in which the fallback itself is not reached, such
  as a flag that stops the run before it.
- Outputs: a doc that says a tool "charts one point" when one point
  draws no chart.

### Keeping Every Text Saying the Same Thing

A fact is often stated in several places: the README, the architecture
doc, a script's help, a file header, a function's docstring, the
command's `--help`, a test's title. An audit that changes one changes
all, and checks that none now says the same fact twice in one text, or
says it two ways. Where two texts must say the same thing, a test can
hold them to it, such as a test that every option a help's examples use
is listed in that help.

## 5. Significant and Minor Findings

A finding is significant when it is:

- a wrong fact, in a doc or in a proposed fix;
- a missing turning point, or a missing step of reasoning;
- a sentence that would mislead a reader into acting wrongly;
- a name or tool used before it is introduced;
- a fix that would leave a file wrong, unclear or repeating itself;
- a change that would break a test or the project's checks.

Wording that is only a matter of taste is minor, and an audit does not
report it.

## 6. Writing a Fix

- Name the file, and the line or heading.
- Quote the whole text the fix replaces, a sentence or a paragraph, and
  give the whole new text. An editor then cannot apply it in the wrong
  place, or leave half of the old text behind.
- Check the new text against the code as hard as the old: a fix can
  bring in a wrong fact of its own.
- After the fix, run the checks that read text: the Markdown lint, the
  link and anchor checks, and the tests that assert on help or message
  text.

## 7. The Fresh-Reader Loop

### Why Fresh Readers

An audit report, or a large rewrite of the docs, is checked by fresh
readers before its fixes are made. A fresh reader is an agent that knows
nothing of the project but its brief, so the text must make sense to a
newcomer, which is the reader the docs are for. Each reader reports only
significant findings; the editor fixes those, and sends the next reader,
until one finds no significant issue. Only then are the fixes made.

A reader that checks every fact repeats the work of every reader before
it. So only the first reader does a full pass. Every later reader also
gets the facts earlier readers confirmed, and a diff of what changed
since the last pass: it skips the confirmed facts, checks the changed
text hardest, and checks against the code only what no reader has
confirmed yet.

### The Files of the Loop

Keep them in one folder beside the report, such as `tmp/<audit>/`:

- `report.md`: the live report, edited after each pass.
- `report-pass-N.md`: a copy of the report exactly as reader N checked
  it.
- `changes-since-pass-N.diff`: what changed after reader N's pass, made
  with `diff report-pass-N.md report-pass-M.md`, where M is the next
  pass.
- `confirmed-facts.md`: every fact a reader confirmed against the
  repository, each with its evidence (file and line), under a heading
  for the reader who confirmed it. A later reader skips a fact unless
  the report now words it differently, or it reads as wrong.

### The Steps of the Loop

1. Copy the report to `report-pass-1.md`, and send reader 1 with the
   full-pass brief.
2. When a reader reports, check each finding against the files and the
   code yourself before fixing anything: a reader can be wrong, and a
   fix it suggests can bring in a wrong fact.
3. Fix each finding that holds, in `report.md`, and add the facts the
   reader confirmed to `confirmed-facts.md`, under its name.
4. Copy `report.md` to the next pass's file, and make the diff from the
   two copies.
5. Send the next reader, a new agent, with the efficient-pass brief.
   Repeat steps 2 to 5 until a reader finds no significant issue; then
   make the fixes.

Send a new agent for every pass, and never go back to full passes after
the first. If a pass is cut off and its copy is missing, rebuild the copy
by undoing the edits made since, then make the diff.

### The Full-Pass Brief

Fill in each part in angle brackets.

```text
You're a fresh reader checking an audit report before anyone acts on it. You know nothing of this project yet, and that's the point: the report must make sense to a reader like you.

The report is <path to report.md>. It audits <what it audits>, and proposes a fix for each problem. Once the report passes, each fix will be made as written, so a wrong fix would go straight into <the files it changes>.

First read the report once, alone, top to bottom. Note every passage you can't follow, every name it uses before saying what it is, and every step of reasoning it skips. Then check it against its sources:
- each item's diagnosis against the files it cites
- each fix's facts against the code it cites, which is in <code paths>, with the tests in <test paths>
- each fix against the report's own rules
- the fixes against each other: whether two now say the same fact twice, contradict each other, or one breaks another
- whether each fix says plainly what it replaces, so that an editor can't apply it wrongly
- whether any change would break a test or the project's checks

Report only significant issues:
- a wrong fact, in a diagnosis or in a fix
- a fix that would leave a file wrong, unclear, or repeating itself
- a missing step of reasoning
- a name or tool the report uses before it's introduced
- anything that would mislead, or break a test

Wording that is only a matter of taste isn't significant. <The project's own exclusions, such as rulings the owner has made.> For each issue, give the item number, what's wrong, the evidence (file and line), and the fix. If you find no significant issue, say so plainly, in one line.

End with a list of the facts you confirmed against the repository, each with its evidence (file and line), so the next reader can skip them.

Change no file. Return your findings as your final message.
```

### The Efficient-Pass Brief

Fill in each part in angle brackets, with N the number of readers so
far.

```text
You're a fresh reader checking an audit report before anyone acts on it. You know nothing of this project yet, and that's the point: the report must make sense to a reader like you.

The report is <path to report.md>. It audits <what it audits>, and proposes a fix for each problem. Once the report passes, each fix will be made as written, so a wrong fix would go straight into <the files it changes>.

<N> readers have already checked the report, and each problem they found has been fixed. Two files save you from repeating their work:
- <path to confirmed-facts.md> lists the facts they confirmed against the repository, each with its evidence. Skip a fact listed there unless the report now words it differently, or it reads as wrong to you.
- <path to changes-since-pass-N.diff> shows what changed in the report since the last reader.

Read the whole report once, alone, top to bottom, as a newcomer: note every passage you can't follow, every name it uses before saying what it is, and every step of reasoning it skips. Then check the changed text hardest. Check against the files and the code only the facts that the confirmed-facts file doesn't list. The code is in <code paths>, the tests in <test paths>. Also check:
- each fix against the report's own rules
- the fixes against each other: whether two now say the same fact twice, contradict each other, or one breaks another
- whether each fix says plainly what it replaces, so that an editor can't apply it wrongly

Report only significant issues:
- a wrong fact, in a diagnosis or in a fix
- a fix that would leave a file wrong, unclear, or repeating itself
- a missing step of reasoning
- a name or tool the report uses before it's introduced
- anything that would mislead, or break a test

Wording that is only a matter of taste isn't significant. <The project's own exclusions.> For each issue, give the item number, what's wrong, the evidence (file and line), and the fix. If you find no significant issue, say so plainly, in one line.

End with a list of the facts you confirmed against the repository that the confirmed-facts file doesn't already list, each with its evidence (file and line), so the next reader can skip them.

Change no file. Return your findings as your final message.
```

The same briefs serve for a set of docs with no report: name the docs
in place of the report, and the code they describe.

## 8. Findings From Past Audits, Before and After

Each pair below is a finding fresh readers raised in the owner's
projects, and the text that fixed it.

| Before | Why it failed | After |
| --- | --- | --- |
| "freeze such a cell only once the week is over" | Did not say which week; a reader counting Sunday to Saturday froze early. | "the week, which MEXC counts from Monday 00:00, … each in UTC" |
| "a coin that traded nothing in the day that holds the time" | The code's day is the UTC day; a reader checked the local day. | "in the UTC day that holds the time" |
| "a key opened at 600,000 rounds of PBKDF2" | PBKDF2 never introduced. | "600,000 rounds of PBKDF2, a function that makes a key from a password" |
| "With no Moralis key saved, the run reads GeckoTerminal." | Wrong with `--source moralis`, which stops the run. | The source rules list the flag's case, and the stops get a section. |
| "charts one point: the ratio of the two prices now" | One point draws no chart. | "gives one point … which draws no chart; it prints the ratio" |
| "The menu's Refresh & freeze keeps the price each cell kept" | Named the menu item before saying what it does. | "runs a tab's cells again and puts each number in place of its formula, so it keeps …" |
| "the larger window MEXC is asked for" | "window" here, "period" everywhere else. | "the larger period MEXC is asked for" |
| "the first column whose name holds date and UTC" | The code's first test is case-sensitive. | The exact rule, with the case each word must have, and an example. |
| "GeckoTerminal refused or failed every try" | Only a 429 is tried again. | "refuses after the last wait, answers with another error, or a request runs out of time" |
| "The script reads the clock" (in a docstring) | The code read it after the request, so a period that ended meanwhile counted as over. | The code reads the clock first, and the docstring says so. |

## 9. Automated Checks Worth Having

- markdownlint, a program that checks the form of Markdown files: with
  `MD024` set to `siblings_only`, a heading may repeat only under
  different parents, and `MD041` makes each file open with a heading.
- A link and anchor check: every link points at a file the repo keeps,
  or at a heading that exists. The owner's projects run one from a
  shared module (`crypto-price-fetchers/lib/repo-checks`), which also
  checks each path in a code span that starts with `.` or `..`.
- A help check: each command line answers `--help` and `-h`, and every
  option its examples use is listed in its help.
- A check that the docs name every test file and helper that exists, and
  that each `npm run` target the command list names is defined.
- Prettier, a program that formats code, for the code and its comments;
  ESLint, which checks JavaScript against rules, with its length rule
  set to pass comments, as these projects set it.

These checks catch form; only a reader catches a wrong fact.

## 10. A Checklist for Each Text

- [ ] Says how the system works now; tells no history.
- [ ] Each topic and sub-topic opens with its context.
- [ ] Each tool and term is introduced at its first mention in this
      text, in four parts.
- [ ] No adjective stands in for a fact; each number has its unit.
- [ ] Every branch of the code that changes the outcome is in the text,
      each exception beside its rule.
- [ ] One word for each idea, and the code's names for settings, files
      and messages.
- [ ] Each figure a setting can change says so, and names the setting.
- [ ] Each day, week or month names its time zone, and each week its
      first day.
- [ ] Each message and output is quoted exactly.
- [ ] A clickable table of contents, three levels deep; unique
      headings; every link resolves.
- [ ] Each JSDoc block matches its code's order and every return case.
- [ ] Each test title still matches what its test holds the code to.
- [ ] Every other text that states the same fact says it the same way.
- [ ] Each fix quotes the whole text it replaces and gives the whole new
      text.
